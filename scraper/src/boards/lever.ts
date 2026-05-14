import * as D from 'drizzle-orm'
import { type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import * as U from '../lib/util.ts'
import * as L from '../lib/log.ts'
import * as T from '../lib/temporal.ts'
import * as Db from '../lib/db.ts'
import * as N from '../lib/network.ts'
import * as Tier from '../tier/index.ts'
import * as C from '../common.ts'

const { lCompany: Company, lJob: Job } = Db

export async function run(db: BetterSQLite3Database, mainLog: L.Log) {
    await import('../sources/lever/companyNames.json', { with: { type: 'json' } }).then(it => {
        C.populateCompanies(mainLog, db, Company, it.default, { checkedEpochMs: null, exists: null, tier: 0 })
    })
    C.initTierEvaluation(mainLog, db, Company, Job, calculateTier)

    const companiesInProcess = new Set<string>()
    let rateLimit = false

    const connection = N.createConnection('https://jobs.lever.co', { connections: 30 })

    while(true) {
        if(rateLimit) await U.delay(T.Now.instant().add({ seconds: 5 }))
        rateLimit = false
        while(companiesInProcess.size > 20) {
            mainLog.I('Stalling because ', [companiesInProcess.size], ' is pending')
            await U.delay(T.Now.instant().add({ seconds: 5 }))
        }

        mainLog.I('Tick (', [companiesInProcess.size], ' pending)')
        const nextTick = T.Now.instant().add({ seconds: 1 })

        const toCheck = C.getCompaniesToCheck(db, Company, [...companiesInProcess, ...C.bannedCompanies])

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

        for(const it of toCheck.desired) handleCompanny(it, 'I')
        for(const it of toCheck.relevant) handleCompanny(it, 'II')
        for(const it of toCheck.other) handleCompanny(it, 'III')
        for(const it of toCheck.missing) handleCompanny(it, '?')

        await U.delay(nextTick)
    }
}

async function checkCompany(
    db: BetterSQLite3Database,
    log: L.Log,
    currentTime: number,
    connection: N.Connection,
    company: D.InferSelectModel<typeof Company>,
    tier: string,
) {
    const result = await requestCompany(log, connection, company.name)
    if(result.status === 'rate-limit') return result

    db.update(Company)
        .set({ checkedEpochMs: currentTime })
        .where(D.eq(Company.name, company.name))
        .run()

    if(result.status === 'not-found') {
        log.I('Company does not exist')

        db.update(Company)
            .set({ exists: 0 })
            .where(D.eq(Company.name, company.name))
            .run()
        return U.status('ok')
    }

    if(result.status !== 'ok') return U.status('ok')

    const initial = company.exists === null

    const existingJobsRows = db.select()
        .from(Job)
        .where(D.eq(Job.companyName, company.name))
        .all()
    const existingJobs = new Set(existingJobsRows.map(it => it.id))

    const toInsert: D.InferSelectModel<typeof Job>[] = []
    const relevancyData: Record<string, unknown>[] = []
    const promises: Promise<void>[] = []
    for(const job of result.data) {
        if(existingJobs.has(job.id)) continue

        const jobDesired = Tier.isJobDesired(job.text, job.descriptionPlain)
        const locationDesired = isLocationDesired(db, job)

        const relevancy: Record<string, unknown> = {
            jr: Tier.isJobRelevant(job.text),
            lr: isLocationRelevant(db, job),
            jd: jobDesired,
            ld: locationDesired,
        }
        const idx = toInsert.length

        toInsert.push({
            id: job.id,
            companyName: company.name,
            fetchedEpochMs: currentTime,
            info: JSON.stringify({
                applyUrl: job.applyUrl,
                categories: job.categories,
                country: job.country,
                createdAt: job.createdAt,
                hostedUrl: job.hostedUrl,
                text: job.text,
                workplaceType: job.workplaceType,
                descriptionPlain: job.descriptionPlain,
            } satisfies JobInfo),
            relevancy: '',
        })
        relevancyData.push(relevancy)

        if(!initial) {
            log.I('New job ', [job.id])
            promises.push((async() => {
                if(!(jobDesired && locationDesired)) return

                const locationDesiredFull = await isLocationDesiredFull(log, db, job)
                relevancyData[idx].pjd = jobDesired
                relevancyData[idx].pld = locationDesiredFull

                if(locationDesiredFull) {
                    log.I('Job ', job.id, ' is relevant!')

                    const ago = C.millisecToDurationString(Date.now() - (job.createdAt || 0))
                    const maxAgo = C.millisecToDurationString(Date.now() - (company.checkedEpochMs || 0))

                    await C.sendMessage(
                        log.addedCtx('job ', [job.id]),
                        db,
                        job.text + ' @ ' + company.name + '\n'
                            + job.workplaceType + ': ' + job.categories.allLocations.join(' | ') + '\n'
                            + `Lever ${tier} ${ago} (< ${maxAgo}) ago: ` + (job.hostedUrl || job.applyUrl),
                    )
                }
            })())
        }
    }

    await Promise.allSettled(promises)

    for(let i = 0; i < toInsert.length; i++) {
        toInsert[i].relevancy = JSON.stringify(relevancyData[i])
    }

    const newTier = toInsert.length > 0
        ? calculateTier(db, company, [...existingJobsRows, ...toInsert])
        : null

    db.transaction(db => {
        db.update(Company)
            .set({ exists: 1, ...(newTier !== null ? { tier: newTier } : {}) })
            .where(D.eq(Company.name, company.name))
            .run()
        if(toInsert.length > 0) {
            db.insert(Job).values(toInsert).run()
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

async function requestCompany(log: L.Log, connection: N.Connection, companyName: string) {
    try {
        // https://github.com/plibither8/jobber/blob/4e079f745526a002463972d99fbbc9825ff0ce13/src/boards/lever.ts#L12
        const response = await N.fetch(connection, {
            method: 'GET',
            path: '/v0/postings/' + encodeURIComponent(companyName),
        })
        if(response.statusCode === 429) {
            log.E('Rate limited')
            await response.body.text().catch(() => {})
            return U.status('rate-limit')
        }
        if(response.statusCode === 404) {
            await response.body.text().catch(() => {})
            return U.status('not-found')
        }

        if(response.statusCode !== 200) {
            log.E('Request failed: ', [response.statusCode], ': ', [await response.body.text().catch(err => err)])
            return U.status('error')
        }

        const json = await response.body.json() as FetchJob[]
        return U.result('ok', json)
    }
    catch(err) {
        log.E('While requesting: ', [err])
        return U.status('error')
    }
}

export type FetchJob = {
    additionalPlain: string
    additional: string
    categories: {
        commitment: string
        department: string
        location: string
        team: string
        allLocations: string[]
    },
    createdAt: number
    descriptionPlain: string
    description: string
    id: string
    lists: {
        text: string
        content: string
    }[]
    text: string
    country: string
    workplaceType: string
    opening: string
    openingPlain: string
    descriptionBody: string
    descriptionBodyPlain: string
    hostedUrl: string
    applyUrl: string
}

function calculateTier(
    db: BetterSQLite3Database,
    _company: D.InferSelectModel<typeof Company>,
    jobs: D.InferSelectModel<typeof Job>[],
): number {
    let hasRelevantLocation = false
    for(const job of jobs) {
        const info: JobInfo | null = JSON.parse(job.info ?? 'null')
        if(!info) continue
        if(!isLocationRelevant(db, info)) continue
        hasRelevantLocation = true
        if(Tier.isJobRelevant(info.text)) return 1
    }
    return hasRelevantLocation ? 2 : 3
}

export function isLocationRelevant(db: BetterSQLite3Database, info: JobInfo) {
    const location = getJobLocation(info)

    const isRemoteWorldwide = location.toLowerCase() === 'remote'
    if(isRemoteWorldwide) return true

    const mentionsUs = location.includes('US') || /(united states|u\. ?s\.|east coast|west coast)/i.test(location)
        || info.country === 'US'// || info.country === null
    if(mentionsUs) return true

    const mentionsUsConcrete = Tier.citiesStatesRegex1.test(location) || Tier.citiesStatesRegex2.test(location)
    if(mentionsUsConcrete) {
        if(C.isLocationInUs(db, location)) return true
    }

    return false
}
export function isLocationDesired(db: BetterSQLite3Database, info: JobInfo) {
    const location = getJobLocation(info)

    const isMyLocal = location.includes('IL') || /(illinois|chicago)/i.test(location)
    if(isMyLocal) return true

    const isRemoteWorldwide = location.toLowerCase() === 'remote'
    if(isRemoteWorldwide) return true

    const isRemote = /(remote|nationwide|continental)/i.test(location) || info.workplaceType === 'remote'
        || /(?<!not )(?<!not a )\bremote/i.test(info.descriptionPlain ?? '')

    const mentionsUs = location.includes('US') || /(united states|u\. ?s\.|east coast|west coast)/i.test(location)
        || info.country === 'US'// || info.country === null
    if(mentionsUs && isRemote) return true

    const mentionsUsConcrete = Tier.citiesStatesRegex1.test(location) || Tier.citiesStatesRegex2.test(location)
    if(mentionsUsConcrete && isRemote) {
        if(C.isLocationInUs(db, location)) return true
    }

    return false
}
export async function isLocationDesiredFull(log: L.Log, db: BetterSQLite3Database, info: JobInfo) {
    const location = getJobLocation(info)

    const isMyLocal = location.includes('IL') || /(illinois|chicago)/i.test(location)
    if(isMyLocal) return true

    const isRemoteWorldwide = location.toLowerCase() === 'remote'
    if(isRemoteWorldwide) return true

    const isRemote = /(remote|nationwide|continental)/i.test(location) || info.workplaceType === 'remote'
        || /(?<!not )(?<!not a )\bremote/i.test(info.descriptionPlain ?? '')

    const mentionsUs = location.includes('US') || /(united states|u\. ?s\.|east coast|west coast)/i.test(location)
        || info.country === 'US'// || info.country === null
    if(mentionsUs && isRemote) return true

    const mentionsUsConcrete = Tier.citiesStatesRegex1.test(location) || Tier.citiesStatesRegex2.test(location)
    if(mentionsUsConcrete && isRemote) {
        if(await C.isLocationInUsFull(log, db, location)) return true
    }

    return false
}

function getJobLocation(info: JobInfo) {
    return [
        ...(info.categories.location ? [info.categories.location] : []),
        ...(info.categories.allLocations ?? []),
    ].join(' | ')
}

type JobInfo = {
    applyUrl: string
    categories: {
        allLocations: string[]
        commitment: string
        department: string
        location: string
        team: string
    }
    descriptionPlain?: string
    country: string | null // 2 letter country code, or multiple
    createdAt: number // epoch ms
    hostedUrl: string
    text: string // title
    workplaceType: string
}
