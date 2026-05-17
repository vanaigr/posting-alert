import * as D from 'drizzle-orm'
import { type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as htmlparser2 from 'htmlparser2'

import * as U from '../lib/util.ts'
import * as L from '../lib/log.ts'
import * as T from '../lib/temporal.ts'
import * as Db from '../lib/db.ts'
import * as N from '../lib/network.ts'
import * as Tier from '../tier/index.ts'
import * as C from '../lib/common.ts'

const { gCompany: Company, gJob: Job } = Db

export async function run(db: BetterSQLite3Database, mainLog: L.Log, sampleSaver: C.SampleSaver) {
    const sampler = sampleSaver.createSampler('greenhouse')
    await import('../sources/greenhouse/companyNames.json', { with: { type: 'json' } }).then(it => {
        C.populateCompanies(mainLog, db, Company, it.default, { checkedEpochMs: null, exists: null, failCount: 0, tier: 0 })
    })
    C.initTierEvaluation(mainLog, db, Company, Job, calculateTier)

    const companiesInProcess = new Set<string>()
    let rateLimit = false

    const connection = N.createConnection('https://boards-api.greenhouse.io', { connections: 30 })

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
            .set({ exists: 0, tier: 3 })
            .where(D.eq(Company.name, company.name))
            .run()
        return U.status('ok')
    }

    if(result.status !== 'ok') {
        C.updateFailCount(log, db, Company, company)
        return U.status('ok')
    }

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
        const id = String(job.id)
        if(existingJobs.has(id)) continue

        const jobDesired = Tier.isJobDesired(job.title, job.content ? parseJobContent(job.content) : undefined)
        const locationDesired = isLocationDesired(db, job)

        const relevancy: Record<string, unknown> = {
            jr: Tier.isJobRelevant(job.title),
            lr: isLocationRelevant(db, job),
            jd: jobDesired,
            ld: locationDesired,
        }
        const idx = toInsert.length

        toInsert.push({
            id,
            companyName: company.name,
            fetchedEpochMs: currentTime,
            info: JSON.stringify(job),
            relevancy: '',
        })
        relevancyData.push(relevancy)

        if(!initial) {
            log.I('New job ', [id])
            promises.push((async() => {
                if(!(jobDesired && locationDesired)) return

                const locationDesiredFull = await isLocationDesiredFull(log, db, job)
                relevancyData[idx].pjd = jobDesired
                relevancyData[idx].pld = locationDesiredFull

                if(locationDesiredFull) {
                    log.I('Job ', id, ' is relevant!')

                    const ago = C.millisecToDurationString(Date.now() - (new Date(job.updated_at).getTime() || 0))
                    const maxAgo = C.millisecToDurationString(Date.now() - (company.checkedEpochMs || 0))

                    await C.sendMessage(
                        log.addedCtx('job ', [id]),
                        db,
                        job.title + ' @ ' + company.name + '\n'
                            + (job.location?.name ?? '') + '\n'
                            + `GH ${tier} ${ago} (< ${maxAgo}) ago: ` + job.absolute_url,
                    )
                }
            })())
        }
    }

    await Promise.allSettled(promises)

    for(let i = 0; i < toInsert.length; i++) {
        toInsert[i].relevancy = JSON.stringify(relevancyData[i])
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
        // https://github.com/grnhse/greenhouse-api-docs/blob/2e9f2d8a573a6843c838cd5f4050f57f23f0494d/source/includes/job-board/_jobs.md?plain=1#L1
        const response = await N.fetch(connection, {
            method: 'GET',
            path: '/v1/boards/' + encodeURIComponent(companyName) + '/jobs?content=true',
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

        const json = await response.body.json() as { jobs: Job[] }
        return U.result('ok', json.jobs)
    }
    catch(err) {
        log.E('While requesting: ', [err])
        return U.status('error')
    }
}

type Job = {
    id: number
    internal_job_id: number | null
    title: string
    updated_at: string
    requisition_id?: string
    location: { name?: string | null | undefined }
    absolute_url: string
    language?: string
    metadata: unknown
    content?: string // html
    departments?: { id: number; name: string; parent_id: number | null; child_ids: number[] }[]
    offices?: { id: number; name: string; location: string; parent_id: number | null; child_ids: number[] }[]
}

function calculateTier(db: BetterSQLite3Database, job: D.InferSelectModel<typeof Job>) {
    const info: Job = JSON.parse(job.info)
    if(isLocationRelevant(db, info)) {
        if(Tier.isJobRelevant(info.title)) return 1
        return 2
    }
    return 3
}

export function isLocationRelevant(db: BetterSQLite3Database, job: Pick<Job, 'location' | 'content'>) {
    if(!job.location.name) return true

    return Tier.isLocationRelevant(db, job.location.name, {
        remote: !job.content || /(?<!not )(?<!not a )\bremote/i.test(job.content),
    })
}
export function isLocationDesired(db: BetterSQLite3Database, job: Pick<Job, 'location' | 'content'>) {
    if(!job.location.name) return true

    return Tier.isLocationDesired(db, job.location.name, {
        remote: !job.content || /(?<!not )(?<!not a )\bremote/i.test(job.content),
    })
}
export async function isLocationDesiredFull(log: L.Log, db: BetterSQLite3Database, job: Pick<Job, 'location' | 'content'>) {
    if(!job.location.name) return true

    return await Tier.isLocationDesiredFull(log, db, job.location.name, {
        remote: !job.content || /(?<!not )(?<!not a )\bremote/i.test(job.content),
    })
}

function parseJobContent(content: string) {
    const htmlParts: string[] = []
    const parser = new htmlparser2.Parser({
        ontext: (text) => {
            htmlParts.push(text)
        }
    })
    parser.write(content)
    parser.end()
    const html = htmlParts.join('')

    return C.parseHtml(html)
}

class KeywordFinder {
    minCount: number
    smoothing: number
    relCounts: Map<string, number>
    irrCounts: Map<string, number>
    nRel: number
    nIrr: number

  constructor({ minCount = 3, smoothing = 1 } = {}) {
    this.minCount = minCount;
    this.smoothing = smoothing;
    this.relCounts = new Map();
    this.irrCounts = new Map();
    this.nRel = 0;
    this.nIrr = 0;
  }

  static _tokenize(s: string) {
    return s.toLowerCase().match(/[a-z.][a-z'#-]{1,}/g) || [];
  }

  add(text: string, relevant: boolean) {
    const tokens = new Set(KeywordFinder._tokenize(text));  // doc frequency
    const target = relevant ? this.relCounts : this.irrCounts;
    if (relevant) this.nRel++; else this.nIrr++;
    for (const t of tokens) target.set(t, (target.get(t) || 0) + 1);
    return this;  // chainable
  }

  score(word: string) {
    const a = this.relCounts.get(word) || 0;
    const b = this.irrCounts.get(word) || 0;
    const s = this.smoothing;
    const pRel = (a + s) / (this.nRel + 2 * s);
    const pIrr = (b + s) / (this.nIrr + 2 * s);
    return Math.log(pRel / pIrr);
  }

  _allScores() {
    const words = new Set([...this.relCounts.keys(), ...this.irrCounts.keys()]);
    const out = [];
    for (const w of words) {
      const a = this.relCounts.get(w) || 0;
      const b = this.irrCounts.get(w) || 0;
      if (a + b < this.minCount) continue;
      out.push({ word: w, score: this.score(w), relDocs: a, irrDocs: b });
    }
    return out;
  }

  topRelevant(n = 50) {
    return this._allScores().sort((x, y) => y.score - x.score).slice(0, n);
  }

  topIrrelevant(n = 50) {
    return this._allScores().sort((x, y) => x.score - y.score).slice(0, n);
  }

  stats() {
    return {
      relevantDocs: this.nRel,
      irrelevantDocs: this.nIrr,
      vocabularySize: new Set([...this.relCounts.keys(), ...this.irrCounts.keys()]).size,
    };
  }

  reset() {
    this.relCounts.clear();
    this.irrCounts.clear();
    this.nRel = 0;
    this.nIrr = 0;
    return this;
  }
}
