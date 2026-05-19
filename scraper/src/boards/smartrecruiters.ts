import * as D from 'drizzle-orm'
import { type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import * as U from '../lib/util.ts'
import * as L from '../lib/log.ts'
import * as T from '../lib/temporal.ts'
import * as Db from '../lib/db.ts'
import * as Tier from '../tier/index.ts'
import * as N from '../lib/network.ts'
import * as C from '../lib/common.ts'

const { smartrecruitersJob: Job, smartrecruitersFetchJobDetails: FetchJobDetails } = Db

export async function run(db: BetterSQLite3Database, mainLog: L.Log, sampleSaver: C.SampleSaver) {
    const sampler = sampleSaver.createSampler('smartrecruiters')

    const jobsInProgress = new Set<string>()
    let rateLimit = false

    const apiConnection = N.createConnection('https://api.smartrecruiters.com')
    const jobsConnection = N.createConnection('https://jobs.smartrecruiters.com')

    while(true) {
        if(rateLimit) await U.delay(T.Now.instant().add({ seconds: 5 }))
        rateLimit = false

        mainLog.I('Tick')
        sampler.count++
        const nextTick = T.Now.instant().add({ seconds: 5 })

        const jobsToCheckDetails = db.select()
            .from(FetchJobDetails)
            .innerJoin(Job, D.eq(FetchJobDetails.id, Job.id))
            .where(D.not(D.inArray(FetchJobDetails.id, [...jobsInProgress])))
            .orderBy(D.asc(FetchJobDetails.addedAt))
            .limit(5)
            .all()

        mainLog.I('Checking, job details: ', [jobsToCheckDetails.length])

        for(const job of jobsToCheckDetails) {
            const log = mainLog.addedCtx([job.smartrecruiters_job.id])
            ;(async() => {
                try {
                    jobsInProgress.add(job.smartrecruiters_fetch_job_details.id)
                    await processJobDetail(db, log, apiConnection, () => rateLimit = true, job)
                }
                catch(err) {
                    log.E([err])
                }
                finally {
                    jobsInProgress.delete(job.smartrecruiters_fetch_job_details.id)
                }
            })()
        }

        const newJobsLog = mainLog.addedCtx('jobs')
        try {
            const result = await updateLatestJobs(db, newJobsLog, jobsConnection)
            if(result.status === 'rate-limit') rateLimit = true
        }
        catch(err) {
            newJobsLog.E([err])
        }

        await U.delay(nextTick)
    }
}

async function updateLatestJobs(
    db: BetterSQLite3Database,
    log: L.Log,
    jobsConnection: N.Connection,
) {
    const fetchedEpochMs = Date.now()

    const requestResult = await request<SearchResponse>(log, jobsConnection, '/sr-jobs/search?limit=100')
    if(requestResult.status === 'rate-limit') return U.status('rate-limit')
    if(requestResult.status !== 'ok') return U.status('ok')

    const existing = new Set(
        db
            .select({ id: Job.id })
            .from(Job)
            .where(D.inArray(Job.id, requestResult.data.content.map(it => it.id)))
            .all()
            .map(it => it.id)
    )

    const companiesToSkip = new Set(C.getCompaniesToSkip(db))

    const toInsert: D.InferInsertModel<typeof Job>[] = []
    const toEnqueueDetails: D.InferSelectModel<typeof FetchJobDetails>[] = []
    for(const job of requestResult.data.content) {
        if(existing.has(job.id)) continue

        const info: ShortInfo = {
            name: job.name,
            company: job.company,
            releasedDate: job.releasedDate,
            location: job.location,
            applyUrl: job.applyUrl,
        }

        const jobDesired = Tier.isJobDesired(info.name, undefined)
        const locationDesired = isLocationDesired({ info, longInfo: null })
        const companyAllowed = !companiesToSkip.has(info.company.identifier)

        toInsert.push({
            id: job.id,
            fetchedEpochMs,
            info: JSON.stringify(info),
            longInfo: null,
            relevancy: JSON.stringify({
                ca: companyAllowed,
                jr: Tier.isJobRelevant(info.name),
                lr: isLocationRelevant({ info, longInfo: null }),
                jd: jobDesired,
                ld: locationDesired,
            }),
        })

        log.I('New job ', [job.id])
        if(companyAllowed && jobDesired && locationDesired) {
            log.I('Job ', job.id, ' is initially relevant, queuing for detail fetch')
            toEnqueueDetails.push({
                id: job.id,
                addedAt: fetchedEpochMs,
            })
        }
    }

    db.transaction(db => {
        if(toInsert.length > 0) {
            db.insert(Job).values(toInsert).run()
        }
        if(toEnqueueDetails.length > 0) {
            db.insert(FetchJobDetails).values(toEnqueueDetails).run()
        }
    })

    log.I('Found ', [toInsert.length], ' new jobs')

    return U.status('ok')
}

type SearchResponse = {
    content: (ShortInfo & { id: string })[]
}
type JobDetailsResponse = {
    jobAd: {
        sections: Record<string, { title: string, text?: string }>
    }
}

type ShortInfo = {
    name: string
    company: {
        identifier: string
        name: string
    }
    releasedDate: string
    location: {
        city: string | null
        region: string | null
        country: string | null
        remote: boolean
        hybrid: boolean
    }
    applyUrl: string
}

type LongInfo = {
    description: [key: string, html: string | null][] // htmls
}

async function processJobDetail(
    db: BetterSQLite3Database,
    log: L.Log,
    apiConnection: N.Connection,
    rateLimit: () => void,
    fetchRow: { smartrecruiters_job: D.InferSelectModel<typeof Job>, smartrecruiters_fetch_job_details: D.InferSelectModel<typeof FetchJobDetails> },
) {
    const info = JSON.parse(fetchRow.smartrecruiters_job.info) as ShortInfo

    if(fetchRow.smartrecruiters_job.longInfo === null) {
        log.I('Fetching job info')
        const responseResult = await request<JobDetailsResponse>(
            log,
            apiConnection,
            `/v1/companies/${encodeURIComponent(info.company.identifier)}/postings/${encodeURIComponent(fetchRow.smartrecruiters_job.id)}`,
            3,
        )
        if(responseResult.status === 'ok') {
            const description: [string, string | null][] = []
            for(const key in responseResult.data.jobAd.sections) {
                description.push([key, responseResult.data.jobAd.sections[key].text ?? null])
            }

            const longInfo = JSON.stringify({ description } satisfies LongInfo)
            db.update(Job).set({ longInfo }).where(D.eq(Job.id, fetchRow.smartrecruiters_job.id)).run()
            fetchRow.smartrecruiters_job.longInfo = longInfo
        }
        else {
            rateLimit()
        }
    }

    let shouldSend = false
    const longInfo: LongInfo = fetchRow.smartrecruiters_job.longInfo ? JSON.parse(fetchRow.smartrecruiters_job.longInfo) : undefined
    if(!longInfo) {
        log.W('Could not get job info. Considering relevant')
        shouldSend = true
    }
    else {
        const jobDesired = Tier.isJobDesired(info.name, getDescription(longInfo.description))
        const locationDesired = isLocationDesired({ info: info, longInfo })
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
                    ...JSON.parse(fetchRow.smartrecruiters_job.relevancy),
                    pjd: jobDesired,
                    pld: locationDesired,
                }),
            })
            .where(D.eq(Job.id, fetchRow.smartrecruiters_job.id))
            .run()
    }

    if(shouldSend) {
        const ago = C.millisecToDurationString(Date.now() - (new Date(info.releasedDate).getTime() || 0))
        // not necesserily, but in vast majority of cases this will only be 5 seconds off.
        const maxAgo = C.millisecToDurationString(Date.now() - fetchRow.smartrecruiters_fetch_job_details.addedAt)

        const remoteness
            = (
                [info.location.remote ? 'Remote' : undefined, info.location.hybrid ? 'Hybrid' : undefined]
                .filter(it => it !== undefined)
                .join('/')
            )
                || 'On-site'

        const location = [info.location.city, info.location.region, info.location.country].filter(it => it).join(', ') || 'none'

        await C.sendMessage(
            log,
            db,
            {
                type: 'boardJob',
                board: 'applytojob',
                extra: {
                    id: fetchRow.smartrecruiters_job.id,
                },
                message: info.name + ' @ ' + info.company.identifier + '\n'
                    + remoteness + ': ' + location + '\n'
                    + `SR ${ago} (< ${maxAgo}) ago: `
                    + info.applyUrl
                    + (Tier.isRequiringClearance(info.name, getDescription(longInfo.description)) ? '⚠️ clearance?' : '')
            },
        )
    }

    db.delete(FetchJobDetails).where(D.eq(FetchJobDetails.id, fetchRow.smartrecruiters_fetch_job_details.id)).run()
}


async function request<R>(log0: L.Log, connection: N.Connection, url: string, tries: number = 1) {
    for(let t = 0; t < tries; t++) {
        const log = t === 0 ? log0 : log0.addedCtx('try ', [t])

        try {
            const response = await N.fetch(connection, { method: 'GET', path: url })
            if(response.statusCode === 429) {
                log.E('Rate limited')
                await response.body.text().catch(() => {})
                return U.status('rate-limit')
            }

            if(response.statusCode !== 200) {
                log.E('Request failed: ', [response.statusCode], ': ', [await response.body.text().catch(err => err)])
                continue
            }

            const json = await response.body.json()
            return U.result('ok', json as R)
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

export function isLocationRelevant(job: { info: ShortInfo, longInfo: LongInfo | null }) {
    const isInUs = job.info.location.country === 'us'
    const isRemoteWorldwide = (!job.info.location.country || job.info.location.country.toLowerCase() === 'worldwide') && job.info.location.remote
    return isInUs || isRemoteWorldwide
}
export function isLocationDesired(job: { info: ShortInfo, longInfo: LongInfo | null }) {
    return isLocationRelevant(job)
    /*
    const isInUs = job.info.location.country === 'us'

    const isMyLocal = job.info.location.region?.toLowerCase() == 'il' || /\bchicago\b/i.test(job.info.location.city ?? '')
    const isRemoteInUs = isInUs && job.info.location.remote
    const isRemoteWorldwide = (!job.info.location.country || job.info.location.country.toLowerCase() === 'worldwide') && job.info.location.remote

    return isMyLocal || isRemoteInUs || isRemoteWorldwide
    */
}

function getDescription(description: [string, string | null][]) {
    let content = description
        .filter(it => it[0] !== 'companyDescription' && it[1] !== null)
        .map(it => C.parseHtml(it[1]!))
        .filter(it => it)
        .join('\n')

    if(!content) {
        content = description
            .filter(it => it[1] !== null)
            .map(it => C.parseHtml(it[1]!))
            .filter(it => it)
            .join('\n')
    }

    return content
}
