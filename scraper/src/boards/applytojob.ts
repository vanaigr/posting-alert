import * as D from 'drizzle-orm'
import { type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { Agent, interceptors, fetch as undiciFetch, Dispatcher } from 'undici'
import * as htmlparser2 from 'htmlparser2'

import * as U from '../lib/util.ts'
import * as L from '../lib/log.ts'
import * as T from '../lib/temporal.ts'
import * as Db from '../lib/db.ts'
import * as Tier from '../tier/index.ts'
import * as C from '../lib/common.ts'

// Scraper info from: https://github.com/kalil0321/ats-scrapers/blob/main/src/jobhive/scrapers/jazzhr.py

const { applytojobCompany: Company, applytojobJob: Job, applytojobFetchJobDetails: FetchJobDetails } = Db

export async function run(db: BetterSQLite3Database, mainLog: L.Log, sampleSaver: C.SampleSaver) {
    const sampler = sampleSaver.createSampler('applytojob')
    await import('../sources/applytojob/companyNames.json', { with: { type: 'json' } }).then(it => {
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

        const toCheck = C.getCompaniesToCheck(db, Company, [...companiesInProcess, ...Tier.bannedCompanies])

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

        for(const { applytojob_fetch_job_details, applytojob_job } of jobsToCheckDetails) {
            const log = mainLog.addedCtx([applytojob_fetch_job_details.companyName], ' job ', [applytojob_fetch_job_details.id])
            ;(async() => {
                try {
                    jobsInProgress.add(applytojob_fetch_job_details.uniqueId)
                    await processJobDetail(db, log, connection, applytojob_fetch_job_details, applytojob_job)
                }
                catch(err) {
                    log.E([err])
                }
                finally {
                    jobsInProgress.delete(applytojob_fetch_job_details.uniqueId)
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
    const result = await request(log, connection, `https://${company.name}.applytojob.com/apply/jobs`)
    if(result.status === 'rate-limit') return result

    const jobs = result.status === 'ok' ? extractJobs(result.data) : undefined

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
        if(!rawJob.id) continue
        if(existingJobs.has(rawJob.id)) continue

        const jobInfo: JobInfo = {
            title: rawJob.title,
            location: rawJob.location,
        }

        const jobDesired = Tier.isJobDesired(jobInfo.title, undefined)
        const locationDesired = isLocationDesired(db, { info: jobInfo, longInfo: null })

        toInsert.push({
            companyName: company.name,
            id: rawJob.id,
            fetchedEpochMs: currentTime,
            info: JSON.stringify(jobInfo),
            longInfo: null,
            relevancy: JSON.stringify({
                jr: Tier.isJobRelevant(jobInfo.title),
                lr: isLocationRelevant(db, { info: jobInfo, longInfo: null }),
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

    const jobUrl = dbJob.id.startsWith('/') ? `https://${dbJob.companyName}.applytojob.com${dbJob.id}` : dbJob.id

    if(dbJob.longInfo === null) {
        log.I('Fetching job info')
        const responseResult = await request(log, dispatcher, jobUrl, 3)
        if(responseResult.status === 'ok') {
            const posting = extractJobPosting(log, responseResult.data)
            if(posting) {
                const longInfo = JSON.stringify({
                    description: posting.description,
                    url: posting.url,
                    locationRequirements: posting.locationRequirements,
                } satisfies LongInfo)
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
        const locationDesired = await isLocationDesiredFull(log, db, { info: job, longInfo })
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
        const longInfo = dbJob.longInfo ? JSON.parse(dbJob.longInfo) as LongInfo : null
        const url = longInfo?.url || jobUrl

        const maxAgo = C.millisecToDurationString(Date.now() - (fetchDetails.jobPostedAfter ?? 0))

        await C.sendMessage(
            log.addedCtx('job ', [dbJob.id]),
            db,
            {
                type: 'boardJob',
                board: 'applytojob',
                extra: {
                    companyName: dbJob.companyName,
                    id: dbJob.id,
                },
                message: job.title + ' @ ' + dbJob.companyName + '\n'
                    + (job.location || 'none') + '\n'
                    + `Applytojob ${fetchDetails.companyTier} < ${maxAgo} ago: ` + url + '\n'
                    + (Tier.isRequiringClearance(job.title, longInfo ? C.parseHtml(longInfo.description) : undefined) ? '⚠️ clearance?' : '')
            },
        )
    }

    db.delete(FetchJobDetails).where(D.eq(FetchJobDetails.uniqueId, fetchDetails.uniqueId)).run()
}

export type JobInfo = {
    title: string
    location: string
}

export type LongInfo = {
    description: string // html
    url: string | null
    locationRequirements: { '@type': string, name: string } | null
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

function calculateTier(db: BetterSQLite3Database, job: D.InferSelectModel<typeof Job>) {
    const info: JobInfo = JSON.parse(job.info)
    const longInfo: LongInfo | null = JSON.parse(job.longInfo ?? 'null')
    if(isLocationRelevant(db, { info, longInfo })) {
        if(Tier.isJobRelevant(info.title)) return 1
        return 2
    }
    return 3
}

function mustBeOutsideUs(longInfo?: LongInfo | null) {
    if(
        longInfo?.locationRequirements
            && longInfo.locationRequirements['@type'] === 'Country'
    ) {
        return longInfo.locationRequirements.name !== 'US'
    }
}

export function isLocationRelevant(db: BetterSQLite3Database, job: { info: JobInfo, longInfo?: LongInfo | null }) {
    if(mustBeOutsideUs(job.longInfo)) return false
    return Tier.isLocationRelevant(db, job.info.location, {
        remote: !job.longInfo?.description || /(?<!not )(?<!not a )\bremote/i.test(job.longInfo?.description),
    })
}
export function isLocationDesired(db: BetterSQLite3Database, job: { info: JobInfo, longInfo?: LongInfo | null }) {
    if(mustBeOutsideUs(job.longInfo)) return false
    return Tier.isLocationDesired(db, job.info.location, {
        remote: !job.longInfo?.description || /(?<!not )(?<!not a )\bremote/i.test(job.longInfo?.description),
    })
}
export async function isLocationDesiredFull(log: L.Log, db: BetterSQLite3Database, job: { info: JobInfo, longInfo?: LongInfo | null }) {
    if(mustBeOutsideUs(job.longInfo)) return false
    return await Tier.isLocationDesiredFull(log, db, job.info.location, {
        remote: !job.longInfo?.description || /(?<!not )(?<!not a )\bremote/i.test(job.longInfo?.description),
    })
}

type RawJob = { id: string, title: string, location: string }

function extractJobs(html: string) {
    const jobs: RawJob[] = []

    let seenColumn = false
    let inColumnDepth = 0
    let currentHref: string | null = null
    let currentTitleParts: string[] = []
    let inJobTitleLink = false

    let inDescription = false
    let inStrong = false
    let descriptionParts: string[] = []

    // We pair anchors and description spans in document order within the jobs column.
    const pendingAnchors: { href: string, title: string }[] = []
    const pendingLocations: string[] = []

    const parser = new htmlparser2.Parser({
        onopentag(name, attribs) {
            if(attribs.id === "jobs_column") {
                seenColumn = true
                inColumnDepth++
            }
            else if(inColumnDepth > 0) {
                inColumnDepth++
                if(name === 'a' && /(^|\s)job_title_link(\s|$)/.test(attribs.class ?? '')) {
                    inJobTitleLink = true
                    currentHref = attribs.href ?? null
                    currentTitleParts = []
                }
                else if(name === 'span' && /(^|\s)resumator_description(\s|$)/.test(attribs.class ?? '')) {
                    inDescription = true
                    descriptionParts = []
                }
                else if(name === 'strong' && inDescription) {
                    inStrong = true
                }
            }
        },
        ontext(text) {
            if(inJobTitleLink) {
                currentTitleParts.push(text)
            }
            if(inDescription && !inStrong) {
                descriptionParts.push(text)
            }
        },
        onclosetag(name) {
            if(inColumnDepth > 0) {
                inColumnDepth--
                if(name === 'a' && inJobTitleLink) {
                    inJobTitleLink = false
                    if(currentHref) {
                        pendingAnchors.push({
                            href: currentHref,
                            title: currentTitleParts.join('').trim(),
                        })
                    }
                    currentHref = null
                }
                else if(name === 'strong' && inStrong) {
                    inStrong = false
                }
                else if(name === 'span' && inDescription) {
                    inDescription = false
                    pendingLocations.push(descriptionParts.join('').trim())
                }
            }
        },
    })
    parser.write(html)
    parser.end()

    if(!seenColumn) return undefined

    const n = Math.min(pendingAnchors.length, pendingLocations.length)
    for(let i = 0; i < n; i++) {
        jobs.push({
            id: pendingAnchors[i].href,
            title: pendingAnchors[i].title,
            location: pendingLocations[i],
        })
    }

    return jobs
}

function extractJobPosting(log: L.Log, html: string): LongInfo | undefined {
    const scripts: string[] = []
    let capturing = false
    let parts: string[] = []

    const parser = new htmlparser2.Parser({
        onopentag(name, attribs) {
            if(name === 'script' && attribs.type === 'application/ld+json') {
                capturing = true
                parts = []
            }
        },
        ontext(text) {
            if(capturing) parts.push(text)
        },
        onclosetag(name) {
            if(name === 'script' && capturing) {
                scripts.push(parts.join(''))
                capturing = false
            }
        },
    })
    parser.write(html)
    parser.end()

    for(const raw of scripts) {
        let parsed: any
        try {
            parsed = JSON.parse(raw)
        }
        catch(err) {
            log.I('Could not parse ld+json: ', [err])
            continue
        }
        if(!parsed || parsed['@type'] !== 'JobPosting') continue

        if(parsed.applicantLocationRequirements?.['@type'] !== 'Country') {
            log.I('Searchme123 ', [parsed.applicantLocationRequirements])
        }

        return {
            description: typeof parsed.description === 'string' ? parsed.description : '',
            url: typeof parsed.url === 'string' ? parsed.url : null,
            locationRequirements: parsed.applicantLocationRequirements,
        }
    }

    log.I('Did not find JobPosting ld+json', [[' ', [html]], 'extra-details'])
    return
}
