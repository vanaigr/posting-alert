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

// Half taken from here: https://github.com/kalil0321/ats-scrapers

// NOTE: not all subdomains are going to be companies, and some unrelated pages will exist
// and fetch, but then contain no jobs. The current impl marks them as existing, but
// since they have no jobs they'll be classified as tier 3 and thus won't interfere with actual company pages.

const { icimsCompany: Company, icimsJob: Job, icimsFetchJobDetails: FetchJobDetails } = Db

export async function run(db: BetterSQLite3Database, mainLog: L.Log, sampleSaver: C.SampleSaver) {
    const sampler = sampleSaver.createSampler('icims')
    await import('../sources/icims/companyNames.json', { with: { type: 'json' } }).then(it => {
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

        const toCheck = C.getCompaniesToCheck(db, Company, [...companiesInProcess, ...Tier.bannedCompanies], {
            quota: 1
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

        for(const { icims_fetch_job_details, icims_job } of jobsToCheckDetails) {
            const log = mainLog.addedCtx([icims_fetch_job_details.companyName], ' job ', [icims_fetch_job_details.id])
            ;(async() => {
                try {
                    jobsInProgress.add(icims_fetch_job_details.uniqueId)
                    await processJobDetail(db, log, connection, icims_fetch_job_details, icims_job)
                }
                catch(err) {
                    log.E([err])
                }
                finally {
                    jobsInProgress.delete(icims_fetch_job_details.uniqueId)
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
    const rawJobs: RawJob[] = []
    let firstPageFailed = false
    let notFound = false

    for(let page = 0;; page++) {
        const url = `https://${company.name}.icims.com/jobs/search?ss=1&pr=${page}&in_iframe=1`
        const result = await request(log.addedCtx('page ', [page]), connection, url)
        if(result.status === 'rate-limit') return result

        if(result.status === 'not-found' || (result.status === 'ok' && result.data.redirected)) {
            notFound = true
            break
        }

        if(result.status !== 'ok') {
            if(page === 0) firstPageFailed = true
            break
        }

        const jobs = extractJobs(log, result.data.html)
        if(!jobs) break
        rawJobs.push(...jobs)
    }

    db.update(Company)
        .set({ checkedEpochMs: currentTime })
        .where(D.eq(Company.name, company.name))
        .run()

    if(notFound) {
        log.I('Company does not exist')

        db.update(Company)
            .set({ exists: 0, tier: 3 })
            .where(D.eq(Company.name, company.name))
            .run()
        return U.status('ok')
    }

    if(firstPageFailed) {
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
    for(const rawJob of rawJobs) {
        const id = rawJob.id
        if(!id) continue
        if(existingJobs.has(id)) continue
        existingJobs.add(id)

        const jobInfo = parseJobInfo(rawJob)

        const jobDesired = Tier.isJobDesired(jobInfo.title, undefined)
        const locationDesired = isLocationDesired(db, { info: jobInfo, longInfo: null })

        toInsert.push({
            companyName: company.name,
            id,
            fetchedEpochMs: currentTime,
            info: JSON.stringify(rawJob),
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
) {
    const job = parseJobInfo(JSON.parse(dbJob.info) as RawJob)

    const jobUrl = `https://${dbJob.companyName}.icims.com/jobs/${dbJob.id}/job`

    if(dbJob.longInfo === null) {
        log.I('Fetching job info')
        const responseResult = await request(log, dispatcher, jobUrl + '?in_iframe=1', 3)
        if(responseResult.status === 'ok') {
            const posting = extractJobPosting(log, responseResult.data.html)
            if(posting) {
                const longInfo = JSON.stringify(posting)
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
            job.title + ' @ ' + dbJob.companyName + '\n'
                + (job.location || 'none') + '\n'
                + `Icims ${fetchDetails.companyTier} < ${maxAgo} ago: ` + url,
        )
    }

    db.delete(FetchJobDetails).where(D.eq(FetchJobDetails.uniqueId, fetchDetails.uniqueId)).run()
}

export type RawJob = {
    id: string
    href: string
    title: string
    location: string | null
    postedDate: string | null
    description: string | null
    requisitionId: string | null
    category: string | null
}

export type JobInfo = {
    title: string
    location: string
}

export type LongInfo = {
    description: string // html
    url: string | null
    datePosted: string | null
}

function parseJobInfo(raw: RawJob): JobInfo {
    return {
        title: raw.title ?? '',
        location: raw.location ?? '',
    }
}

async function request(log0: L.Log, connection: Dispatcher | undefined, url: string, tries: number = 1) {
    for(let t = 0; t < tries; t++) {
        const log = t === 0 ? log0 : log0.addedCtx('try ', [t])

        try {
            const response = await undiciFetch(url, {
                dispatcher: connection,
                headers: {
                    "User-Agent": "Mozilla/5.0",
                    Accept: 'text/html',
                    cookie: 'JSESSIONID=52CC06587858D150719A333D72BB6355',
                }
            })

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

            const requestedHost = new URL(url).host
            let finalHost: string
            try {
                finalHost = new URL(response.url).host
            }
            catch {
                finalHost = requestedHost
            }
            const redirected = response.redirected || finalHost !== requestedHost

            const html = await response.text()
            return U.result('ok', { html, redirected })
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
    const info = parseJobInfo(JSON.parse(job.info) as RawJob)
    const longInfo: LongInfo | null = JSON.parse(job.longInfo ?? 'null')
    if(isLocationRelevant(db, { info, longInfo })) {
        if(Tier.isJobRelevant(info.title)) return 1
        return 2
    }
    return 3
}

export function isLocationRelevant(db: BetterSQLite3Database, job: { info: JobInfo, longInfo?: LongInfo | null }) {
    return Tier.isLocationRelevant(db, job.info.location, {
        remote: !job.longInfo?.description || /(?<!not )(?<!not a )\bremote/i.test(job.longInfo?.description),
    })
}
export function isLocationDesired(db: BetterSQLite3Database, job: { info: JobInfo, longInfo?: LongInfo | null }) {
    return Tier.isLocationDesired(db, job.info.location, {
        remote: !job.longInfo?.description || /(?<!not )(?<!not a )\bremote/i.test(job.longInfo?.description),
    })
}
export async function isLocationDesiredFull(log: L.Log, db: BetterSQLite3Database, job: { info: JobInfo, longInfo?: LongInfo | null }) {
    return await Tier.isLocationDesiredFull(log, db, job.info.location, {
        remote: !job.longInfo?.description || /(?<!not )(?<!not a )\bremote/i.test(job.longInfo?.description),
    })
}

// Each posting is one <li class="iCIMS_JobCardItem">…</li>. We match the whole
// card so location, posted date and description (which sit OUTSIDE the anchor)
// stay associated with the right job.
const JOB_CARD_RE = /<li[^>]+class="[^"]*iCIMS_JobCardItem[^"]*"[^>]*>([\s\S]*?)<\/li>/gi
// Anchor inside a card — gives us href, id, and the <h3> title.
const JOB_ANCHOR_RE = /<a[^>]+href="(https?:\/\/[^"]*?\/jobs\/(\d+)\/[^"]*?\/job[^"]*)"[^>]*class="[^"]*iCIMS_Anchor[^"]*"[^>]*>([\s\S]*?)<\/a>/i
const TITLE_RE = /<h3[^>]*>([\s\S]*?)<\/h3>/i
// `<span class="sr-only field-label">Job Locations</span> <span>VALUE</span>`
const LOCATION_RE = /<span[^>]+class="[^"]*sr-only[^"]*field-label[^"]*"[^>]*>\s*Job Locations\s*<\/span>\s*<span[^>]*>\s*([^<]*?)\s*<\/span>/i
// Posted-at: `<span title="5/6/2026 10:23 AM">3 hours ago…</span>`. The title
// attribute is the absolute timestamp; we keep it as the raw string.
const DATE_TITLE_RE = /<span[^>]+title="(\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)"/i
// Per-job header `<dt>{label}</dt> <dd><span>{value}</span></dd>` pairs.
const HEADER_TAG_RE = /<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>/gi
const DESC_RE = /<div[^>]+class="[^"]*col-xs-12[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/div>/i
// iCIMS encodes locations as Country-State-City (e.g. "US-SC-Prosperity",
// "CA-ON-Toronto"). We reverse to City, State, Country for readability and
// consistency with the other boards — but only when the dash shape matches;
// opaque strings ("Remote", "Multiple Locations") pass through unchanged.
const DASH_LOC_RE = /^([A-Z]{2,3})-([A-Z0-9 ]{1,40})(?:-([^-].*))?$/

function strip(html: string) {
    return C.parseHtml(html)
}

function htmlUnescape(s: string) {
    return s
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#0*39;/g, "'")
        .replace(/&#x0*27;/gi, "'")
}

function extractJobs(log: L.Log, html: string): RawJob[] | undefined {
    const jobs: RawJob[] = []
    const seenInPage = new Set<string>()

    JOB_CARD_RE.lastIndex = 0
    let card: RegExpExecArray | null
    while((card = JOB_CARD_RE.exec(html)) !== null) {
        const body = card[1]

        const anchor = JOB_ANCHOR_RE.exec(body)
        if(anchor === null) continue

        const id = anchor[2]
        // iCIMS sometimes renders multiple anchors per job (title + icon
        // link); dedup within the page so cross-page logic gets clean input.
        if(seenInPage.has(id)) continue
        seenInPage.add(id)

        const titleMatch = TITLE_RE.exec(anchor[3])
        if(!titleMatch) continue
        const title = strip(titleMatch[1])
        if(!title) continue

        jobs.push({
            id,
            href: htmlUnescape(anchor[1]),
            title,
            location: extractLocation(body),
            postedDate: extractPostedAt(body),
            description: extractDescription(body),
            requisitionId: extractRequisitionId(body),
            category: extractHeaderValue(body, 'Category'),
        })
    }

    if(jobs.length === 0) {
        log.W('No job cards found on page')
        return undefined
    }
    return jobs
}

function normalizeLocation(raw: string) {
    const match = DASH_LOC_RE.exec(raw)
    if(!match) return raw
    return [match[3], match[2], match[1]]
        .filter((it): it is string => !!it && !!it.trim())
        .map(it => it.trim())
        .join(', ')
}

function extractLocation(cardBody: string): string | null {
    const match = LOCATION_RE.exec(cardBody)
    if(match) {
        const raw = strip(match[1])
        if(raw) return normalizeLocation(raw)
    }
    // Fall back to the per-job header tags (City / State / Country).
    const parts: { city?: string, state?: string, country?: string } = {}
    HEADER_TAG_RE.lastIndex = 0
    let tag: RegExpExecArray | null
    while((tag = HEADER_TAG_RE.exec(cardBody)) !== null) {
        const label = strip(tag[1]).toLowerCase()
        const value = strip(tag[2])
        if(!value) continue
        if(label.includes('city')) parts.city = value
        else if(label.includes('state') || label.includes('province')) parts.state = value
        else if(label.includes('country')) parts.country = value
    }
    const ordered = [parts.city, parts.state, parts.country]
        .filter((it): it is string => !!it)
    return ordered.length > 0 ? ordered.join(', ') : null
}

function extractPostedAt(cardBody: string): string | null {
    const match = DATE_TITLE_RE.exec(cardBody)
    return match ? match[1].trim() : null
}

function extractDescription(cardBody: string): string | null {
    const match = DESC_RE.exec(cardBody)
    if(!match) return null
    const text = strip(match[1])
    return text || null
}

function extractRequisitionId(cardBody: string): string | null {
    return extractHeaderValue(cardBody, 'Requisition ID') ?? extractHeaderValue(cardBody, 'ID')
}

// Look up a `<dt>{label}</dt><dd><span>{value}</span></dd>` pair by exact label.
function extractHeaderValue(cardBody: string, label: string): string | null {
    const needle = label.toLowerCase()
    HEADER_TAG_RE.lastIndex = 0
    let tag: RegExpExecArray | null
    while((tag = HEADER_TAG_RE.exec(cardBody)) !== null) {
        if(strip(tag[1]).toLowerCase() === needle) {
            const value = strip(tag[2])
            return value || null
        }
    }
    return null
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

        const candidates: any[] = Array.isArray(parsed)
            ? parsed
            : Array.isArray(parsed?.['@graph'])
                ? parsed['@graph']
                : [parsed]

        for(const candidate of candidates) {
            if(!candidate || candidate['@type'] !== 'JobPosting') continue

            return {
                description: typeof candidate.description === 'string' ? candidate.description : '',
                url: typeof candidate.url === 'string' ? candidate.url : null,
                datePosted: typeof candidate.datePosted === 'string' ? candidate.datePosted : null,
            }
        }
    }

    log.I('Did not find JobPosting ld+json', [[' ', [html]], 'extra-details'])
    return
}
