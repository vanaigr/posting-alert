import * as D from 'drizzle-orm'
import { type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { Agent, interceptors, fetch as undiciFetch, Dispatcher } from 'undici'

import * as U from '../lib/util.ts'
import * as L from '../lib/log.ts'
import * as T from '../lib/temporal.ts'
import * as Db from '../lib/db.ts'
import * as Tier from '../tier/index.ts'
import * as C from '../common.ts'

const { zohorecruitCompany: Company, zohorecruitJob: Job, zohorecruitFetchJobDetails: FetchJobDetails } = Db

export async function run(db: BetterSQLite3Database, mainLog: L.Log, sampleSaver: C.SampleSaver) {
    const sampler = sampleSaver.createSampler('zohorecruit')
    await import('../sources/zohorecruit/companyNames.json', { with: { type: 'json' } }).then(it => {
        C.populateCompanies(mainLog, db, Company, it.default, {
            checkedEpochMs: null,
            exists: null,
            tier: 0,
            failCount: 0,
        })
    })
    C.initTierEvaluation(mainLog, db, Company, Job, calculateTier)

    const companiesInProcess = new Set<string>()
    const jobsInProgress = new Set<string>()
    let rateLimit = false

    const connection = new Agent({}).compose(interceptors.dns())

    while(true) {
        if(rateLimit) await U.delay(T.Now.instant().add({ seconds: 5 }))
        rateLimit = false
        while(companiesInProcess.size > 20) {
            mainLog.I('Stalling because ', [companiesInProcess.size], ' is pending')
            await U.delay(T.Now.instant().add({ seconds: 5 }))
        }

        mainLog.I('Tick (', [companiesInProcess.size], ' pending)')
        sampler.count++
        const nextTick = T.Now.instant().add({ seconds: 1 })

        const toCheck = C.getCompaniesToCheck(db, Company, [...companiesInProcess, ...C.bannedCompanies], {
            quota: 4, // too few companies + stalls a lot
        })

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
            'job details: ', [jobsToCheckDetails.length],
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

    if(result.status === 'not-found' || (result.status === 'ok' && !jobs)) {
        log.I('Company does not exist')

        db.update(Company)
            .set({ exists: 0, tier: 3 })
            .where(D.eq(Company.name, company.name))
            .run()
        return U.status('ok')
    }

    if(result.status !== 'ok') {
        const newFailCount = company.failCount + 1
        if(newFailCount >= 10 && company.exists === null) {
            log.I('Marking company inactive after ', [newFailCount], ' fetch fails')
            db.update(Company)
                .set({ exists: 0, tier: 3, failCount: newFailCount })
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
    for(const rawJob of jobs!) {
        if(typeof rawJob.id !== 'string') continue

        if(existingJobs.has(rawJob.id)) continue

        const jobInfo: JobInfo = {
            title: '' + (rawJob.Posting_Title || rawJob.Job_Opening_Name || ''),
            remote: !!rawJob.Remote_Job,
            country: '' + (rawJob.Country || rawJob.Country1 || ''),
            state: '' + (rawJob.State || ''),
            city: '' + (rawJob.City || ''),
        }

        const jobDesired = Tier.isJobDesired(jobInfo.title, undefined)
        const locationDesired = isLocationDesired(jobInfo)

        toInsert.push({
            companyName: company.name,
            id: rawJob.id,
            fetchedEpochMs: currentTime,
            info: JSON.stringify(jobInfo),
            longInfo: typeof rawJob.Job_Description === 'string' && rawJob.Job_Description
                ? JSON.stringify({ description: rawJob.Job_Description } satisfies LongInfo)
                : null,
            relevancy: JSON.stringify({
                jr: Tier.isJobRelevant(jobInfo.title),
                lr: isLocationRelevant(jobInfo),
                jd: jobDesired,
                ld: locationDesired,
            }),
        })

        if(!initial) {
            log.I('New job ', [rawJob.id])
            if(jobDesired && locationDesired) {
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

    const newTier = toInsert.length > 0 || !company.exists
        ? C.evaluateCompanyTier(db, [...existingJobsRows, ...toInsert], calculateTier)
        : null

    db.transaction(db => {
        db.update(Company)
            .set({ exists: 1, failCount: 0, ...(newTier !== null ? { tier: newTier } : {}) })
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
        const responseResult = await request(log, dispatcher, `https://${dbJob.companyName}.zohorecruit.com/jobs/Careers/${encodeURIComponent(dbJob.id)}`, 3)
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
        const jobDesired = Tier.isJobDesired(job.title, C.parseHtml(longInfo.description))
        const locationDesired = isLocationDesired(job)
        if(jobDesired && locationDesired) {
            log.I('Job is still relevant after detail check')
            shouldSend = true
        }
        else {
            log.I('Job is not relevant after detail check')
        }

        db.update(Job)
            .set({
                relevancy: JSON.stringify({
                    ...JSON.parse(dbJob.relevancy),
                    pjd: jobDesired,
                    pld: locationDesired,
                }),
            })
            .where(D.and(D.eq(Job.companyName, dbJob.companyName), D.eq(Job.id, dbJob.id)))
            .run()
    }

    if(shouldSend) {
        const workplaceType = (() => {
            if(job.remote) return 'Remote'
            else return 'On-site'
        })()

        const location = [job.city, job.country].filter(it => it).join(', ') || 'none'

        const maxAgo = C.millisecToDurationString(Date.now() - (fetchDetails.jobPostedAfter ?? 0))

        await C.sendMessage(
            log.addedCtx('job ', [dbJob.id]),
            db,
            job.title + ' @ ' + dbJob.companyName + '\n'
                + workplaceType + ': ' + location + '\n'
                + `Zoho ${fetchDetails.companyTier} < ${maxAgo} ago: `
                + `https://${dbJob.companyName}.zohorecruit.com/jobs/Careers/${encodeURIComponent(dbJob.id)}`,
        )
    }

    db.delete(FetchJobDetails).where(D.eq(FetchJobDetails.uniqueId, fetchDetails.uniqueId)).run()
}

type LongInfo = {
    description: string // html
}

async function request(log0: L.Log, connection: Dispatcher | undefined, url: string, tries: number = 1) {
    for(let t = 0; t < tries; t++) {
        const log = t === 0 ? log0 : log0.addedCtx('try ', [t])

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
                continue
            }

            const html = await response.text()
            return U.result('ok', html)
        }
        catch(err) {
            log.E('While requesting: ', [err])
            continue
        }
    }

    if(tries !== 0) {
        log0.I('Returning error after ', [tries], ' tries')
    }
    return U.status('error')
}

function calculateTier(_db: BetterSQLite3Database, job: D.InferSelectModel<typeof Job>) {
    const info: JobInfo | null = JSON.parse(job.info ?? 'null')
    if(info) {
        if(isLocationRelevant(info)) {
            if(Tier.isJobRelevant(info.title)) return 1
            return 2
        }
    }
    return 3
}

export function isLocationRelevant(info: JobInfo) {
    const isInUs = info.country.includes('US') || /(united states|u\. ?s\.)/i.test(info.country)
    const isRemoteWorldwide = !info.country && !info.city

    return isInUs || isRemoteWorldwide
}

export function isLocationDesired(info: JobInfo) {
    const cityState = info.city + ', ' + info.state

    const isInUs = info.country.includes('US') || /(united states|u\. ?s\.)/i.test(info.country)
    const isRemote = /(remote|nationwide)/i.test(info.title) || info.remote
    const isRemoteInUs = isRemote && isInUs
    const isRemoteWorldwide = !info.country && !info.city
    const isMyLocal = cityState.includes('IL') || /(illinois|chicago)/i.test(cityState)

    return isMyLocal || isRemoteInUs || isRemoteWorldwide
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
