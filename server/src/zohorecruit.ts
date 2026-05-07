import * as D from 'drizzle-orm'
import { type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { Agent, interceptors, fetch as undiciFetch, Dispatcher } from 'undici'

import * as U from './lib/util.ts'
import * as L from './lib/log.ts'
import * as T from './lib/temporal.ts'
import * as Db from './lib/db.ts'
import * as AshbyTiers from './ashbyhq/tier.ts'

const { zohorecruitCompany: Company, zohorecruitJob: Job, zohorecruitFetchJobDetails: FetchJobDetails } = Db

const quota = 5

export async function run(db: BetterSQLite3Database, mainLog: L.Log) {
    await (async() => {
        const companyNames = await import(
            './sources/zohorecruit/companyNames.json',
            { with: { type: 'json' }},
        ).then(it => it.default)

        for(let i = 0; i < companyNames.length; i += 3000) {
            const toInsert = companyNames
                .slice(i, i + 3000)
                .map(it => ({ name: it, checkedEpochMs: null, exists: null, failCount: 0, tier: 0 }))

            db.insert(Company)
                .values(toInsert)
                .onConflictDoNothing()
                .execute()
        }
        mainLog.I('Populated companies')
    })()

    db.run(D.sql`CREATE TABLE IF NOT EXISTS zohorecruit_tmp (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        json TEXT NOT NULL
    )`)

    const companiesInProcess = new Set<string>()
    const jobsInProgress = new Set<string>()
    let rateLimit = false

    const connection = new Agent({}).compose(interceptors.dns())

    U.evaluateTiers(mainLog, db, Company, Job, calculateTier)

    while(true) {
        if(rateLimit) await U.delay(T.Now.instant().add({ seconds: 5 }))
        rateLimit = false
        while(companiesInProcess.size > 20) {
            mainLog.I('Stalling because ', [companiesInProcess.size], ' is pending')
            await U.delay(T.Now.instant().add({ seconds: 5 }))
        }

        mainLog.I('Tick (', [companiesInProcess.size], ' pending)')
        const nextTick = T.Now.instant().add({ seconds: 1 })

        const toCheck = (() => {
            const companiesToSkip = [...companiesInProcess, ...U.bannedCompanies]

            const overnightInfo = U.getOvernightInfo()
            if(overnightInfo.isOvernight) {
                const other = db.select().from(Company)
                    .where(D.and(
                        D.eq(Company.exists, 1),
                        D.eq(Company.tier, 3),
                        D.not(D.inArray(Company.name, companiesToSkip)),
                    ))
                    .orderBy(D.sql`${Company.checkedEpochMs} ASC NULLS FIRST`)
                    .limit(quota)
                    .all()

                if(other.length !== 0 && (other[0].checkedEpochMs === null || other[0].checkedEpochMs < overnightInfo.overnightBegin)) {
                    return { missing: [], desired: [], relevant: [], other }
                }
            }

            const missing = db.select().from(Company)
                .where(D.and(
                    D.isNull(Company.exists),
                    D.not(D.inArray(Company.name, companiesToSkip)),
                ))
                .orderBy(D.sql`${Company.checkedEpochMs} ASC NULLS FIRST`)
                .limit(quota)
                .all()

            const desired = db.select().from(Company)
                .where(D.and(
                    D.eq(Company.exists, 1),
                    D.eq(Company.tier, 1),
                    D.not(D.inArray(Company.name, companiesToSkip)),
                ))
                .orderBy(D.sql`${Company.checkedEpochMs} ASC NULLS FIRST`)
                .limit(quota)
                .all()
            const relevant = db.select().from(Company)
                .where(D.and(
                    D.eq(Company.exists, 1),
                    D.eq(Company.tier, 2),
                    D.not(D.inArray(Company.name, companiesToSkip)),
                ))
                .orderBy(D.sql`${Company.checkedEpochMs} ASC NULLS FIRST`)
                .limit(quota)
                .all()

            const tiersCounts = U.selectCompanies([desired, relevant], [0.5, 0.25], quota - missing.length)
            desired.length = tiersCounts[0]
            relevant.length = tiersCounts[1]

            return { missing, desired, relevant, other: [] as D.InferSelectModel<typeof Company>[] }
        })()

        const jobsToCheckDetails = db.select()
            .from(FetchJobDetails)
            .innerJoin(Job, D.and(D.eq(FetchJobDetails.companyName, Job.companyName), D.eq(FetchJobDetails.id, Job.id)))
            .where(D.not(D.inArray(FetchJobDetails.uniqueId, [...jobsInProgress])))
            .orderBy(D.asc(FetchJobDetails.addedAt))
            .limit(5)
            .all()

        mainLog.I(
            'Checking: ',
            [toCheck.desired.length], ', ',
            [toCheck.relevant.length], ', ',
            [toCheck.other.length], ', ',
            [toCheck.missing.length], ', ',
        )

        const currentTime = Date.now()
        const handleCompanny = async(company: D.InferSelectModel<typeof Company>, tier: string) => {
            const log = mainLog.addedCtx(company.name)

            try {
                companiesInProcess.add(company.name)
                const result = await checkCompany(db, log, currentTime, connection, company, tier)
                if(result.status === 'rate-limit') rateLimit = true
            }
            catch(err) {
                log.E('While checking: ', [err])
            }
            finally {
                companiesInProcess.delete(company.name)
            }
        }

        for(const it of toCheck.missing) handleCompanny(it, '?')
        for(const it of toCheck.desired) handleCompanny(it, 'I')
        for(const it of toCheck.relevant) handleCompanny(it, 'II')
        for(const it of toCheck.other) handleCompanny(it, 'III')

        for(const { zohorecruit_fetch_job_details, zohorecruit_job } of jobsToCheckDetails) {
            const log = mainLog.addedCtx([zohorecruit_fetch_job_details.companyName], ' job ', [zohorecruit_fetch_job_details.id])
            ;(async() => {
                try {
                    jobsInProgress.add(zohorecruit_fetch_job_details.uniqueId)
                    await processJobDetail(db, log, connection, zohorecruit_fetch_job_details, zohorecruit_job)
                }
                catch(err) {
                    log.E([err])
                }
                finally {
                    jobsInProgress.delete(zohorecruit_fetch_job_details.uniqueId)
                }
            })()
        }

        await U.delay(nextTick)
    }
}

async function checkCompany(
    db: BetterSQLite3Database,
    log: L.Log,
    currentTime: number,
    connection: Dispatcher,
    company: D.InferSelectModel<typeof Company>,
    tier: string,
) {
    const result = await request(log, connection, `https://${company.name}.zohorecruit.com/jobs/Careers`)
    if(result.status === 'rate-limit') return result

    const jobs = result.status === 'ok' ? extractJobs(log, result.data) : undefined

    db.update(Company)
        .set({ checkedEpochMs: currentTime })
        .where(D.eq(Company.name, company.name))
        .run()

    if(result.status === 'not-found' || !jobs) {
        log.I('Company does not exist')

        db.update(Company)
            .set({ exists: 0, failCount: 0 })
            .where(D.eq(Company.name, company.name))
            .run()
        return U.status('ok')
    }

    if(result.status !== 'ok') {
        const newFailCount = company.failCount + 1
        if(newFailCount >= 10 && company.exists === null) {
            log.I('Marking company inactive after ', [newFailCount], ' fetch fails')
            db.update(Company)
                .set({ exists: 0, failCount: newFailCount })
                .where(D.eq(Company.name, company.name))
                .run()
        }
        else {
            db.update(Company)
                .set({ failCount: newFailCount })
                .where(D.eq(Company.name, company.name))
                .run()
        }
        return U.status('ok')
    }

    const initial = company.exists === null

    const existingJobsRows = db.select()
        .from(Job)
        .where(D.eq(Job.companyName, company.name))
        .all()
    const existingJobs = new Set(existingJobsRows.map(it => it.id))

    const toInsert: D.InferSelectModel<typeof Job>[] = []
    const toEnqueueDetails: D.InferSelectModel<typeof FetchJobDetails>[] = []
    for(const rawJob of jobs) {
        if(typeof rawJob.id !== 'string') continue

        if(existingJobs.has(rawJob.id)) continue

        const jobInfo: JobInfo = {
            title: '' + (rawJob.Posting_Title || rawJob.Job_Opening_Name || ''),
            remote: !!rawJob.Remote_Job,
            country: '' + (rawJob.Country || rawJob.Country1 || ''),
            state: '' + (rawJob.State || ''),
            city: '' + (rawJob.City || ''),
        }

        toInsert.push({
            companyName: company.name,
            id: rawJob.id,
            fetchedEpochMs: currentTime,
            info: JSON.stringify(jobInfo),
            longInfo: typeof rawJob.Job_Description === 'string' && rawJob.Job_Description
                ? JSON.stringify({ description: rawJob.Job_Description } satisfies LongInfo)
                : null,
        })

        if(!initial) {
            log.I('New job ', [rawJob.id])
            if(AshbyTiers.isJobDesired(jobInfo.title, undefined) && isLocationDesired(jobInfo)) {
                log.I('Job ', rawJob.id, ' is initially relevant, queuing for detail fetch')
                toEnqueueDetails.push({
                    uniqueId: U.getHash(company.name, rawJob.id),
                    id: rawJob.id,
                    companyName: company.name,
                    addedAt: currentTime,
                    jobPostedAfter: company.checkedEpochMs ?? 0,
                    companyTier: tier,
                })
            }
        }
    }

    const newTier = toInsert.length > 0
        ? calculateTier(company, [...existingJobsRows, ...toInsert])
        : null

    db.transaction(db => {
        db.update(Company)
            .set({ exists: 1, ...(newTier !== null ? { tier: newTier } : {}) })
            .where(D.eq(Company.name, company.name))
            .run()
        if(toInsert.length > 0) {
            db.insert(Job).values(toInsert).run()
        }
        if(toEnqueueDetails.length > 0) {
            db.insert(FetchJobDetails).values(toEnqueueDetails).run()
        }
    })

    if(initial) {
        log.I('Found ', [toInsert.length], ' jobs')
    }
    else {
        log.I('Found ', [toInsert.length], ' new jobs')
    }

    return U.status('ok')
}

async function processJobDetail(
    db: BetterSQLite3Database,
    log: L.Log,
    dispatcher: Dispatcher,
    fetchDetails: D.InferSelectModel<typeof FetchJobDetails>,
    dbJob: D.InferSelectModel<typeof Job>,
) {
    const job = JSON.parse(dbJob.info) as JobInfo

    if(dbJob.longInfo === null) {
        log.I('Fetching job info')
        const responseResult = await request(log, dispatcher, `https://${dbJob.companyName}.zohorecruit.com/jobs/Careers/${encodeURIComponent(dbJob.id)}`)
        if(responseResult.status === 'ok') {
            const description = extractJobDescription(log, responseResult.data)
            if(description) {
                const longInfo = JSON.stringify({ description } satisfies LongInfo)
                db.update(Job).set({ longInfo }).where(D.and(D.eq(Job.companyName, dbJob.companyName), D.eq(Job.id, dbJob.id))).run()
                dbJob.longInfo = longInfo
            }
        }
        else {
            // TODO: report rate-limit up
        }
    }

    let shouldSend = false
    if(!dbJob.longInfo) {
        log.W('Could not get job info. Considering relevant')
        shouldSend = true
    }
    else {
        const longInfo = JSON.parse(dbJob.longInfo) as LongInfo
        if(AshbyTiers.isJobDesired(job.title, longInfo.description) && isLocationDesired(job)) {
            log.I('Job is still relevant after detail check')
            shouldSend = true
        }
        else {
            log.I('Job is not relevant after detail check')
        }
    }

    if(shouldSend) {
        const workplaceType = (() => {
            if(job.remote) return 'Remote'
            else return 'On-site'
        })()

        const location = [job.city, job.country].filter(it => it).join(', ') || 'none'

        const ago = U.millisecToDurationString(Date.now() - (fetchDetails.jobPostedAfter ?? 0))

        await U.sendMessage(
            log.addedCtx('job ', [dbJob.id]),
            db,
            job.title + ' @ ' + dbJob.companyName + '\n'
                + workplaceType + ': ' + location + '\n'
                + `Zoho ${fetchDetails.companyTier} < ${ago} ago: ` + `https://${dbJob.companyName}.zohorecruit.com/jobs/Careers/${encodeURIComponent(dbJob.id)}`,
        )
    }

    db.delete(FetchJobDetails).where(D.eq(FetchJobDetails.uniqueId, fetchDetails.uniqueId)).run()
}

type LongInfo = {
    description: string // html
}

async function request(log: L.Log, connection: Dispatcher | undefined, url: string) {
    try {
        const response = await undiciFetch(url, { dispatcher: connection })
        if(response.status === 429) {
            log.E('Rate limited')
            await response.text().catch(() => {})
            return U.status('rate-limit')
        }

        if(response.status === 404) {
            await response.text().catch(err => err)
            log.E('Not found')
            return U.status('not-found')
        }
        if(response.status !== 200) {
            log.E('Request failed: ', [response.status], ': ', [await response.text().catch(err => err)])
            return U.status('error')
        }

        const html = await response.text()
        return U.result('ok', html)
    }
    catch(err) {
        log.E('While requesting: ', [err])
        return U.status('error')
    }
}

function calculateTier(
    _company: D.InferSelectModel<typeof Company>,
    jobs: D.InferSelectModel<typeof Job>[],
): number {
    let hasRelevantLocation = false
    for(const job of jobs) {
        const info: JobInfo | null = JSON.parse(job.info ?? 'null')
        if(!info) continue
        if(!isLocationRelevant(info)) continue
        hasRelevantLocation = true
        if(AshbyTiers.isJobRelevant(info.title)) return 1
    }
    return hasRelevantLocation ? 2 : 3
}

// NOTE: if this is changed, add a migration that resets tiers for the companies.
export function isLocationRelevant(info: JobInfo) {
    const cityState = info.city + ', ' + info.state

    const isInUs = info.country.includes('US') || /(united states|u\. ?s\.)/i.test(info.country)
    const mentionsUsConcrete = AshbyTiers.citiesStatesRegex1.test(cityState) || AshbyTiers.citiesStatesRegex2.test(cityState)
    const isRemote = /(remote|nationwide)/i.test(info.title) || info.remote
    const isRemoteInUs = isRemote && (isInUs || mentionsUsConcrete)
    const isRemoteWorldwide = !info.country && !info.city

    return isInUs || mentionsUsConcrete || isRemoteInUs || isRemoteWorldwide
}

export function isLocationDesired(info: JobInfo) {
    const cityState = info.city + ', ' + info.state

    const isInUs = info.country.includes('US') || /(united states|u\. ?s\.)/i.test(info.country)
    const mentionsUsConcrete = AshbyTiers.citiesStatesRegex1.test(cityState) || AshbyTiers.citiesStatesRegex2.test(cityState)
    const isRemote = /(remote|nationwide)/i.test(info.title) || info.remote
    const isRemoteInUs = isRemote && (isInUs || mentionsUsConcrete)
    const isRemoteWorldwide = !info.country && !info.city
    const isMyLocal = cityState.includes('IL') || /(illinois|chicago)/i.test(cityState)

    return isRemoteInUs || isRemoteWorldwide || isMyLocal
}

function extractJobDescription(log: L.Log, html: string) {
    const prefix = "var jobs = JSON.parse('"
    const beginI = html.indexOf(prefix)
    if(beginI === -1) {
        log.I('Did not find jobs array start', [[' ', [html]], 'extra-details'])
        return
    }

    const endI = html.indexOf("'", beginI + prefix.length)
    if(endI === -1) {
        log.I('Did not find jobs array end', [[' ', [html]], 'extra-details'])
        return
    }

    const jsonEncoded = html.substring(beginI + prefix.length, endI)
    const json = jsonEncoded.replaceAll(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|.)/g, (match) => {
        if(match.startsWith('\\x')) {
            return String.fromCodePoint(parseInt(match.slice(2, 4), 16))
        }
        else if(match.startsWith('\\u')) {
            return String.fromCodePoint(parseInt(match.slice(2, 6), 16))
        }
        else {
            return match.slice(1)
        }
    })
    const object = (() => {
        try {
            return JSON.parse(json)
        }
        catch(err) {
            log.I('Could not parse json ', [err], [[' ', [html]], 'extra-details'])
            return undefined
        }
    })()
    if(!object) return

    return object[0].Job_Description as string
}

function extractJobs(log: L.Log, html: string) {
    for(const match of html.matchAll(/<input /g)) {
        const end = html.indexOf('>', match.index + 7)
        if(end === -1) continue

        const toSeach = html.substring(match.index + 7, end) // not exploding the memory here. Trust
        if(!toSeach.includes('id="jobs"')) continue

        const prefix = 'value="'
        let valueBegin = toSeach.indexOf(prefix)
        if(valueBegin === -1) continue
        valueBegin += prefix.length

        const valueEnd = toSeach.indexOf('"', valueBegin)
        if(valueEnd === -1) continue

        const jsonEncoded = toSeach.substring(valueBegin, valueEnd)
        const json = jsonEncoded.replaceAll(/&#([^;]+);/g, (match, capture) => {
            const number = parseInt(capture, 10)
            if(!isFinite(number)) return match
            return String.fromCodePoint(capture)
        })
        const object = (() => {
            try {
                return JSON.parse(json)
            }
            catch(err) {
                log.I('Could not parse json ', [err], ', ', [match.index], [[' ', [html]], 'extra-details'])
                return undefined
            }
        })()
        if(!object) continue

        return object as FetchJob[]
    }

    log.I('Could not find jobs array ', [[' ', [html]], 'extra-details'])
}

/*
const jobs = extractJobs(L.makeLogger(), await fetch('https://academicsinasia.zohorecruit.com/jobs/Careers').then(it => it.text()))
console.log(jobs)
*/

type JobInfo = {
    title: string
    remote: boolean
    country: string
    state: string
    city: string
}

// Yes, this is really the type. Anything can be anything
type FetchJob = {
    id?: unknown

    Remote_Job?: unknown
    Job_Opening_Name?: unknown
    Posting_Title?: unknown
    Job_Description?: unknown

    City?: unknown
    State?: unknown
    Country?: unknown
    Country1?: unknown

    [K: string]: any
}
