import * as D from 'drizzle-orm'
import { type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { Agent, interceptors, fetch as undiciFetch, type Dispatcher } from 'undici'

import * as U from '../lib/util.ts'
import * as L from '../lib/log.ts'
import * as T from '../lib/temporal.ts'
import * as Db from '../lib/db.ts'
import * as Tier from '../tier/index.ts'
import * as C from '../lib/common.ts'
import { type Sampler } from '../lib/analytics.ts'

// Mostly copied from: https://github.com/kalil0321/ats-scrapers/blob/71d9a560a00071938a0ee0827d1e23badc104e93/src/jobhive/scrapers/oracle.py#L238

const { oraclecloudCompany: Company, oraclecloudJob: Job, oraclecloudFetchJobDetails: FetchJobDetails } = Db

export async function run(db: BetterSQLite3Database, mainLog: L.Log, sampler: Sampler) {
    await import('../sources/oraclecloud/companies.json', { with: { type: 'json' } }).then(it => {
        populateOraclecloudCompanies(mainLog, db, it.default)
    })
    C.initTierEvaluation(mainLog, db, Company, Job, calculateTier)

    const companiesInProcess = new Set<string>()
    const jobsInProgress = new Set<string>()
    let rateLimit = false

    const dispatcher = new Agent({}).compose(interceptors.dns())

    const oneTimeQuota = 4
    const maxQuota = 4

    while(true) {
        if(rateLimit) await U.delay(T.Now.instant().add({ seconds: 5 }))
        rateLimit = false
        while(companiesInProcess.size > 20) {
            mainLog.I('Stalling because ', [companiesInProcess.size], ' is pending')
            await U.delay(T.Now.instant().add({ seconds: 5 }))
        }

        mainLog.I('Tick (', [companiesInProcess.size], ' pending)')
        sampler.sample()
        const nextTick = T.Now.instant().add({ seconds: 1 })

        const toCheck = C.getCompaniesToCheck(db, Company, [...companiesInProcess], {
            quota: Math.min(Math.max(0, maxQuota - companiesInProcess.size), oneTimeQuota),
        })

        const jobsToCheckDetails = db.select()
            .from(FetchJobDetails)
            .innerJoin(Job, D.and(D.eq(FetchJobDetails.companyName, Job.companyName), D.eq(FetchJobDetails.id, Job.id)))
            .innerJoin(Company, D.eq(FetchJobDetails.companyName, Company.name))
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
        const handleCompany = async(company: D.InferSelectModel<typeof Company>, tier: string) => {
            const log = mainLog.addedCtx([company.subdomain], ', ', [company.region])

            try {
                companiesInProcess.add(company.name)
                const result = await checkCompany(db, log, currentTime, dispatcher, company, tier)
                if(result.status === 'rate-limit') rateLimit = true
            }
            catch(err) {
                log.E('While checking: ', [err])
            }
            finally {
                companiesInProcess.delete(company.name)
            }
        }

        for(const it of toCheck.missing) handleCompany(it, '?')
        for(const it of toCheck.desired) handleCompany(it, 'I')
        for(const it of toCheck.relevant) handleCompany(it, 'II')
        for(const it of toCheck.other) handleCompany(it, 'III')

        for(const { oraclecloud_fetch_job_details, oraclecloud_job, oraclecloud_company } of jobsToCheckDetails) {
            const log = mainLog.addedCtx([oraclecloud_company.subdomain], '/', [oraclecloud_company.region], ' job ', [oraclecloud_fetch_job_details.id])
            ;(async() => {
                try {
                    jobsInProgress.add(oraclecloud_fetch_job_details.uniqueId)
                    await processJobDetail(db, log, dispatcher, oraclecloud_fetch_job_details, oraclecloud_job, oraclecloud_company)
                }
                catch(err) {
                    log.E([err])
                }
                finally {
                    jobsInProgress.delete(oraclecloud_fetch_job_details.uniqueId)
                }
            })()
        }

        await U.delay(nextTick)
    }
}

function makeBaseUrl(subdomain: string, region: string) {
    return new URL(`https://${subdomain}.fa.${region}.oraclecloud.com`)
}

function populateOraclecloudCompanies(log: L.Log, db: BetterSQLite3Database, pairs: string[][]) {
    for(let i = 0; i < pairs.length; i += 3000) {
        const toInsert = pairs.slice(i, i + 3000).map(([subdomain, region, cx]) => ({
            name: U.getHash(subdomain, region, cx),
            subdomain,
            region,
            cx,
            humanName: null,
            checkedEpochMs: null,
            exists: null,
            tier: 0,
            failCount: 0,
        }))
        db.insert(Company).values(toInsert).onConflictDoNothing().execute()
    }
    log.I('Populated companies')
}

async function checkCompany(
    db: BetterSQLite3Database,
    log: L.Log,
    currentTime: number,
    dispatcher: Dispatcher,
    company: D.InferSelectModel<typeof Company>,
    tier: string,
) {
    const pageLimit = 200
    const baseUrl = makeBaseUrl(company.subdomain, company.region)

    const preliminaryResult = await request<SiteSettingsResponse>(
        log.addedCtx('settings'),
        dispatcher,
        new URL(
            `hcmRestApi/CandidateExperience/en/siteSettings/${company.cx}`,
            baseUrl,
        ).toString(),
    )

    if(preliminaryResult.status === 'rate-limit') return preliminaryResult

    const humanName = preliminaryResult.status === 'ok'
        ? preliminaryResult.data.app?.siteName
        : undefined

    if(humanName) company.humanName = humanName
    db.update(Company)
        .set({ checkedEpochMs: currentTime, ...(humanName !== undefined ? { humanName } : {}) })
        .where(D.eq(Company.name, company.name))
        .run()

    if(preliminaryResult.status === 'not-found') {
        log.I('Company does not exist')
        db.update(Company)
            .set({ exists: 0, tier: 3 })
            .where(D.eq(Company.name, company.name))
            .run()
        return U.status('ok')
    }

    if(preliminaryResult.status === 'error') {
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

    const rawJobs: RawJob[] = []
    for(let offset = 0;;) {
        log.I('Fetching at ', [offset])

        const url = new URL('hcmRestApi/resources/latest/recruitingCEJobRequisitions', baseUrl)
        url.searchParams.set('onlyData', 'true') // chesterton's fence
        url.searchParams.set('expand', 'requisitionList')
        url.searchParams.set(
            'finder',
            // siteNumber is chesterton's fence as well
            `findReqs;siteNumber=${company.cx},limit=${pageLimit},offset=${offset}`,
        )

        const result = await request<JobsResponse>(log.addedCtx('offset ', [offset]), dispatcher, url.toString())
        if(result.status === 'rate-limit') return result
        if(result.status !== 'ok') break

        const { items, total } = unwrap(result.data)
        if(!items.length) break
        rawJobs.push(...items)
        offset += items.length
        if(total !== undefined && offset >= total) break

        await U.delay(T.Now.instant().add({ seconds: 1 }))
    }

    const initial = company.exists === null

    const existingJobsRows = db.select()
        .from(Job)
        .where(D.eq(Job.companyName, company.name))
        .all()
    const existingJobs = new Set(existingJobsRows.map(it => it.id))

    const toInsert: D.InferSelectModel<typeof Job>[] = []
    const toEnqueueDetails: D.InferSelectModel<typeof FetchJobDetails>[] = []
    for(const rawJob of rawJobs) {
        const id = rawJob.Id
        if(!id || existingJobs.has(id)) continue
        existingJobs.add(id)

        const jobInfo: JobInfo = {
            title: rawJob.Title ?? '',
            locations: [
                { name: rawJob.PrimaryLocation ?? '', country: rawJob.PrimaryLocationCountry ?? '' },
                ...(rawJob.secondaryLocations ?? []).map(it => ({ name: it.Name ?? '', country: it.CountryCode ?? '' }))
            ],
        }

        const jobDesired = Tier.isJobDesired(jobInfo.title, undefined)
        const locationDesired = isLocationDesired(db, { info: jobInfo, longInfo: null })

        toInsert.push({
            companyName: company.name,
            id,
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
            log.I('New job ', [id])
            if(jobDesired && locationDesired) {
                log.I('Job ', id, ' is initially relevant, queuing for detail fetch')
                toEnqueueDetails.push({
                    uniqueId: U.getHash(company.name, id),
                    id,
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
    dbCompany: D.InferSelectModel<typeof Company>,
) {
    const info = JSON.parse(dbJob.info) as JobInfo
    const baseUrl = makeBaseUrl(dbCompany.subdomain, dbCompany.region)

    if(dbJob.longInfo === null) {
        log.I('Fetching job info')

        const url = new URL('hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails', baseUrl)
        url.searchParams.set('onlyData', 'true')
        url.searchParams.set('finder', `ById;Id=${fetchDetails.id}`)

        const responseResult = await request<JobDetailsResponse>(log, dispatcher, url.toString(), 3)
        if(responseResult.status === 'ok') {
            const detail = responseResult.data.items?.[0]
            const description = [
                detail?.ExternalDescriptionStr,
                detail?.ExternalResponsibilitiesStr,
                detail?.ExternalQualificationsStr,
            ]
                .filter((it): it is string => typeof it === 'string' && !!it.trim())
                .join('\n\n')
            const longInfo = JSON.stringify({ description } satisfies LongInfo)
            db.update(Job).set({ longInfo }).where(D.and(D.eq(Job.companyName, dbJob.companyName), D.eq(Job.id, dbJob.id))).run()
            dbJob.longInfo = longInfo
        }
        else {
            // TODO: report rate-limit up
        }
    }

    let shouldSend = false
    const longInfo = dbJob.longInfo ? JSON.parse(dbJob.longInfo) as LongInfo : undefined
    if(!longInfo) {
        log.W('Could not get job info. Considering relevant')
        shouldSend = true
    }
    else {
        const jobDesired = Tier.isJobDesired(info.title, C.parseHtml(longInfo.description))
        const locationDesired = await isLocationDesiredFull(log, db, { info, longInfo })
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
        const urlUrl = new URL('hcmUI/CandidateExperience/en/sites/CX_1/job/' + encodeURIComponent(fetchDetails.id), baseUrl)
        const url = urlUrl.toString()

        const maxAgo = C.millisecToDurationString(Date.now() - (fetchDetails.jobPostedAfter ?? 0))
        const location = infoToLocation(info)

        await C.sendMessage(
            log,
            db,
            {
                type: 'boardJob',
                board: 'oraclecloud',
                extra: {
                    companyName: dbJob.companyName,
                    id: dbJob.id,
                },
                message: info.title + ' @ ' + (dbCompany.humanName || `${dbCompany.subdomain}/${dbCompany.region}`) + '\n'
                    + location + '\n'
                    + `Oracle ${fetchDetails.companyTier} (< ${maxAgo}) ago: ` + url
                    + (Tier.isRequiringClearance(info.title, longInfo ? C.parseHtml(longInfo.description) : undefined) ? '\n⚠️ clearance?' : '')
            },
        )
    }

    db.delete(FetchJobDetails).where(D.eq(FetchJobDetails.uniqueId, fetchDetails.uniqueId)).run()
}

async function request<R>(log0: L.Log, dispatcher: Dispatcher, url: string, tries: number = 1) {
    for(let t = 0; t < tries; t++) {
        const log = t === 0 ? log0 : log0.addedCtx('try ', [t])

        try {
            const response = await undiciFetch(url, {
                dispatcher,
                headers: {
                    'accept': 'application/json',
                    'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
                },
            })
            if(response.status === 429) {
                log.E('Rate limited')
                await response.text().catch(() => {})
                return U.status('rate-limit')
            }
            if(response.status === 404) {
                await response.text().catch(() => {})
                return U.status('not-found')
            }
            if(response.status !== 200) {
                log.E('Request failed: ', [response.status], ': ', [await response.text().catch(err => err)])
                continue
            }

            const jsonResult = await response.json().then(
                it => U.result('ok', it as R),
                err => U.result('error', err),
            )
            if(jsonResult.status !== 'ok') return U.status('not-found')

            return jsonResult
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

function unwrap(payload: JobsResponse): { items: RawJob[], total: number | undefined } {
    const items = payload.items ?? []
    if(!items.length || typeof items[0] !== 'object' || items[0] === null) {
        return { items: [], total: undefined }
    }
    const item0 = items[0]
    const reqs = item0.requisitionList
    if(!Array.isArray(reqs)) return { items: [], total: item0.TotalJobsCount }
    return { items: reqs, total: item0.TotalJobsCount }
}


export type JobInfo = {
    title: string
    locations: { name: string, country: string }[]
}

export type LongInfo = {
    description: string
}

type SiteSettingsResponse = {
    app?: { siteName?: string }
}

type JobsResponse = {
    items?: Array<{
        requisitionList?: RawJob[]
        TotalJobsCount?: number
    }>
}

type JobDetailsResponse = {
    items?: Array<{
        ExternalDescriptionStr?: string
        ExternalResponsibilitiesStr?: string
        ExternalQualificationsStr?: string
    }>
}

type RawJob = {
    Id?: string
    //RequisitionNumber?: string
    Title?: string
    //PostedDate?: string
    //CreatedOn?: string
    PrimaryLocation?: string
    PrimaryLocationCountry?: string
    secondaryLocations?: Array<{
        CountryCode?: string
        Name?: string
    }>
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

export function isLocationRelevant(db: BetterSQLite3Database, job: { info: JobInfo, longInfo?: LongInfo | null }) {
    return Tier.isLocationRelevant(db, infoToLocation(job.info), {
        mentionsUs: checkMentionsUs(job.info),
        remote: !job.longInfo?.description || /(?<!not )(?<!not a )\bremote/i.test(job.longInfo?.description),
    })
}
export function isLocationDesired(db: BetterSQLite3Database, job: { info: JobInfo, longInfo?: LongInfo | null }) {
    return Tier.isLocationDesired(db, infoToLocation(job.info), {
        mentionsUs: checkMentionsUs(job.info),
        remote: !job.longInfo?.description || /(?<!not )(?<!not a )\bremote/i.test(job.longInfo?.description),
    })
}
export async function isLocationDesiredFull(log: L.Log, db: BetterSQLite3Database, job: { info: JobInfo, longInfo?: LongInfo | null }) {
    return await Tier.isLocationDesiredFull(log, db, infoToLocation(job.info), {
        mentionsUs: checkMentionsUs(job.info),
        remote: !job.longInfo?.description || /(?<!not )(?<!not a )\bremote/i.test(job.longInfo?.description),
    })
}

function infoToLocation(info: JobInfo) {
    return info.locations.map(it => it.name).join(' | ')
}
function checkMentionsUs(info: JobInfo) {
    return info.locations.some(it => it.country === 'US')
}
