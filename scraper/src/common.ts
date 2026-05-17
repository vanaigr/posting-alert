import * as fs from 'node:fs/promises'
import * as D from 'drizzle-orm'
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as htmlparser2 from 'htmlparser2'
import { OpenRouter } from '@openrouter/sdk'

import * as L from './lib/log.ts'
import * as U from './lib/util.ts'
import * as T from './lib/temporal.ts'
import * as N from './lib/network.ts'
import * as Db from './lib/db.ts'

type InferTable<T> = T extends infer V ? V extends D.Table ? D.InferSelectModel<V> : never : never

export type AnyCompanyTable = typeof Db.aCompany | typeof Db.lCompany | typeof Db.gCompany
    | typeof Db.bamboohrCompany | typeof Db.zohorecruitCompany | typeof Db.gemCompany
    | typeof Db.ripplingCompany | typeof Db.applytojobCompany
export type AnyComany = InferTable<AnyCompanyTable>

export type AnyJobTable = typeof Db.aJob | typeof Db.lJob | typeof Db.gJob
    | typeof Db.bamboohrJob | typeof Db.zohorecruitJob | typeof Db.gemJob
    | typeof Db.ripplingJob | typeof Db.applytojobJob
export type AnyJob = InferTable<AnyJobTable>


export function selectCompanies<T>(tiers: T[][], probabilities: number[], quota: number): number[] {
    const selectCounts = Array(tiers.length).fill(0)
    const candidateTierIndices: number[] = []
    // TODO: this is biased if e.g. there's 100500 tier0 and 5 tier1.
    for(let iteration = 0; iteration < quota; iteration++) {
        candidateTierIndices.length = 0
        let totalProbability = 0
        for(let tierI = 0; tierI < tiers.length; tierI++) {
            if(selectCounts[tierI] >= tiers[tierI].length) continue
            const probability = probabilities[tierI]
            if(probability <= 0) continue
            candidateTierIndices.push(tierI)
            totalProbability += probability
        }
        if(candidateTierIndices.length === 0) break

        const v = Math.random() * totalProbability

        let sum = 0
        let tierIndexIndex = 0
        for(; tierIndexIndex < candidateTierIndices.length - 1; tierIndexIndex++) {
            sum += probabilities[candidateTierIndices[tierIndexIndex]]
            if(v < sum) break
        }

        selectCounts[candidateTierIndices[tierIndexIndex]]++
    }

    return selectCounts
}

async function trySendMessage(log: L.Log, message: string): Promise<boolean> {
    try {
        const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                chat_id: process.env.TELEGRAM_CHAT_ID,
                text: message,
                link_preview_options: {
                    is_disabled: true,
                },
            })
        })
        if(!response.ok) throw new Error(`${response.status}: ${await response.text().catch(it => it)}`)
        const body = await response.json()
        if(!body.ok) {
            throw new Error(`Telegram error: ${body.description}`)
        }
        log.I('Sent successfully')
        return true
    }
    catch(err) {
        log.E('While sending notification: ', [err])
        return false
    }
}

export async function sendMessage(log: L.Log, db: BetterSQLite3Database, message: string) {
    const originalEpochMs = Date.now()
    const ok = await trySendMessage(log, message)
    if(!ok) {
        db.insert(Db.pendingNotification).values({ message, originalEpochMs }).run()
        log.I('Persisted notification for retry')
    }
}

export async function runPendingNotificationService(db: BetterSQLite3Database, log: L.Log) {
    while(true) {
        await U.delay(T.Now.instant().add({ seconds: 10 }))

        const rows = db.select().from(Db.pendingNotification).all()
        for(const row of rows) {
            const suffix = '\n' + `Delayed by: ${millisecToDurationString(Date.now() - row.originalEpochMs)}`
            const ok = await trySendMessage(log.addedCtx('retry ', [row.id]), row.message + suffix)
            if(!ok) continue

            try {
                db.delete(Db.pendingNotification).where(D.eq(Db.pendingNotification.id, row.id)).run()
            }
            catch(err) {
                log.E('Failed to delete pending notification ', [row.id], ': ', [err])
            }
        }
    }
}

export async function runLocationClassificationService(db: BetterSQLite3Database, log: L.Log) {
    while(true) {
        const row = db.select().from(Db.locationClassification)
            .where(D.eq(Db.locationClassification.isInUs, ''))
            .limit(1)
            .get()
        if(row) {
            await isLocationInUsFull(log, db, row.location)
            await U.delay(T.Now.instant().add({ seconds: 1 }))
        }
        else {
            await U.delay(T.Now.instant().add({ seconds: 60 }))
        }
    }
}

export class Sampler {
    count: number
    name: string
    constructor(name: string) {
        this.count = 0
        this.name = name
    }
}

export class SampleSaver {
    private samplers: Sampler[] = []

    constructor() {
        this.run()
    }

    createSampler(name: string): Sampler {
        const sampler = new Sampler(name)
        this.samplers.push(sampler)
        return sampler
    }

    private async run() {
        if(!process.env.RECORD_SAMPLES) return

        while(true) {
            await U.delay(T.Now.instant().add({ minutes: 1 }))

            const time = T.Now.instant()
                .toZonedDateTimeISO(process.env.SEARCH_TIMEZONE!)
                .toPlainTime()
                .toString()

            let out = time + ':\n'
            for(const sampler of this.samplers) {
                out += `  - ${sampler.name}: ${sampler.count}\n`
                sampler.count = 0
            }
            out += '\n'

            await fs.appendFile('./samples.txt', out)
        }
    }
}

export function millisecToDurationString(ms: number) {
    const sec = ms / 1000

    if(sec < 0) return 'error'
    if(sec < 60) return '<1 min'
    const min = Math.round(sec / 60)
    if(min < 180)  return min +' min'
    const hour = Math.round(min / 60)
    if(hour <= 24) return hour + ' hr'
    return '>1 d'
}

export const bannedCompanies = [
    'jobgether',
    'g2i',
]

export function evaluateCompanyTier<J extends { companyName: string }>(
    db: BetterSQLite3Database,
    jobs: J[],
    calculateTier: (db: BetterSQLite3Database, job: J) => number,
) {
    let companyTier = 3
    for(const job of jobs) {
        const tier = calculateTier(db, job)
        companyTier = Math.min(companyTier, tier)
        if(companyTier === 1) break
    }
    return companyTier
}

export function initTierEvaluation<J extends AnyJobTable>(
    log: L.Log,
    db: BetterSQLite3Database,
    Company: AnyCompanyTable,
    Job: J,
    calculateTier: (db: BetterSQLite3Database, job: D.InferSelectModel<J>) => number,
) {
    const evaluateTiers = () => {
        const companies = db.select({ name: Company.name }).from(Company).all() as { name: string }[]
        log.I('Recalculating tier for ', [companies.length], ' companies')

        const tiersByCompany = new Map<string, number>()
        for(let lastRowid = 0;;) {
            const chunk = db.select({
                ...D.getTableColumns(Job) as any,
                rowid: D.sql<number>`rowid`,
            })
                .from(Job)
                .where(D.sql`rowid > ${lastRowid}`)
                .orderBy(D.sql`rowid`)
                .limit(4000)
                .all()

            for(const row of chunk) {
                const companyTier = tiersByCompany.get(row.companyName) ?? 3
                if(companyTier === 1) continue

                const tier = calculateTier(db, row as any)
                tiersByCompany.set(row.companyName, Math.min(companyTier, tier))
            }

            if(chunk.length === 0) break
            lastRowid = chunk.at(-1)!.rowid
        }

        const tiers = new Map<number, string[]>([[1, []], [2, []], [3, []]])
        for(const company of companies) {
            tiers.get(tiersByCompany.get(company.name) ?? 3)!.push(company.name)
        }

        db.transaction(tx => {
            for(const [tier, companies] of tiers) {
                if(companies.length > 0) {
                    tx.update(Company).set({ tier }).where(D.inArray(Company.name, companies)).run()
                }
            }
        })

        log.I([tiers.get(1)!.length], ', ', [tiers.get(2)!.length], ', ', [tiers.get(3)!.length])

        const now = T.Now.instant()
        const nowZdt = now.toZonedDateTimeISO(process.env.SEARCH_TIMEZONE!)
        let nextCheckZdt = nowZdt
            .with(
                { hour: 2, minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 },
                { disambiguation: 'earlier' },
            )
            .add({ hours: 1 })
        if(T.ZonedDateTime.compare(nextCheckZdt, nowZdt) <= 0) nextCheckZdt = nextCheckZdt.add({ days: 1 })

        // Schedule reevaluation since LLM might've classified some locations and
        // jobs that were relevant before are now not relevant.
        setTimeout(
            () => evaluateTiers(),
            nextCheckZdt.toInstant().since(now).total('milliseconds'),
        )
    }

    evaluateTiers()
}

export function getOvernightInfo() {
    const now = T.Now.instant()

    const overnightBegin = now
        .toZonedDateTimeISO(process.env.SEARCH_TIMEZONE!)
        .with(
            { hour: 2, minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 },
            { disambiguation: 'earlier' },
        )
        .toInstant()
    const overnightEnd = overnightBegin.add({ hours: 1 })

    return {
        overnightBegin: overnightBegin.epochMilliseconds,
        isOvernight: T.Instant.compare(overnightBegin, now) <= 0
            && T.Instant.compare(now, overnightEnd) < 0,
    }
}

const typescript1 = <T extends AnyCompanyTable>(db: BetterSQLite3Database, Company: T) => db.select().from(Company).all()
type GetCompaniesToCheckReturn<T extends AnyCompanyTable> = {
    missing: ReturnType<typeof typescript1<T>>
    desired: ReturnType<typeof typescript1<T>>
    relevant: ReturnType<typeof typescript1<T>>
    other: ReturnType<typeof typescript1<T>>
}

export function getCompaniesToCheck<T extends AnyCompanyTable>(
    db: BetterSQLite3Database,
    Company: T,
    companiesToSkip: string[],
    options?: { quota?: number, weights?: [number, number] }
): GetCompaniesToCheckReturn<T> {
    const quota = options?.quota ?? 5
    const weights = options?.weights ?? [0.5, 0.25]

    const overnightInfo = getOvernightInfo()
    if(overnightInfo.isOvernight) {
        const other = db.select().from(Company)
            .where(D.and(
                // NOTE: also includes nonexistent companies
                D.eq(Company.tier, 3),
                D.not(D.inArray(Company.name, companiesToSkip)),
            ))
            .orderBy(D.sql`${Company.checkedEpochMs} ASC NULLS FIRST`)
            .limit(quota)
            .all()

        if(other.length !== 0 && (other[0].checkedEpochMs === null || other[0].checkedEpochMs < overnightInfo.overnightBegin)) {
            return {
                desired: [],
                relevant: [],
                other,
                missing: [],
            }
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
            D.eq(Company.tier, 1),
            D.not(D.inArray(Company.name, companiesToSkip)),
        ))
        .orderBy(D.sql`${Company.checkedEpochMs} ASC NULLS FIRST`)
        .limit(quota)
        .all()
    const relevant = db.select().from(Company)
        .where(D.and(
            D.eq(Company.tier, 2),
            D.not(D.inArray(Company.name, companiesToSkip)),
        ))
        .orderBy(D.sql`${Company.checkedEpochMs} ASC NULLS FIRST`)
        .limit(quota)
        .all()

    const tiersCounts = selectCompanies([desired, relevant], weights, quota - missing.length)
    desired.length = tiersCounts[0]
    relevant.length = tiersCounts[1]

    return {
        desired,
        relevant,
        other: [],
        missing,
    }
}

export function populateCompanies<T extends AnyCompanyTable>(
    log: L.Log,
    db: BetterSQLite3Database,
    Company: T,
    companyNames: string[],
    // NOTE: typescript language server goes crazy if this is insert model
    // it says property does not exist in the type where it exists. tsc reports no errors.
    baseCompanyRecord: Omit<D.InferSelectModel<T>, 'name'>,
) {
    for(let i = 0; i < companyNames.length; i += 3000) {
        const toInsert = companyNames.slice(i, i + 3000).map(it => ({ ...baseCompanyRecord, name: it }))

        db.insert(Company)
            .values(toInsert as any)
            .onConflictDoNothing()
            .execute()
    }
    log.I('Populated companies')
}

export async function fetchGraphql<T extends {}>(connection: N.Connection, log: L.Log, path: string, body: any) {
    type GraphqlWrapper = {
        data?: T
        errors?: { message: string }[]
    }

    try {
        const response = await N.fetch(connection, {
            path,
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body)
        })
        if(response.statusCode === 429) {
            log.E('Rate limited')
            await response.body.text().catch(() => {})
            return U.status('rate-limit')
        }
        if(response.statusCode !== 200) {
            log.E(
                'Request failed (soft): ',
                [response.statusCode],
                ' with ',
                ...await response.body.text().then(
                    (it: string): L.Message => ['body ', [it]],
                    (err: unknown): L.Message => ['body error ', [err]],
                ),
            )
            return U.status('error')
        }

        const json = await response.body.json() as GraphqlWrapper
        if(json.data === undefined) {
            log.E('Query failed: ', [json])
            return U.status('error')
        }
        return U.result('ok', json.data)
    }
    catch(err) {
        log.E('Request failed: ', [err])
        return U.status('error')
    }
}

//const barrier = Symbol()
export function parseHtml(html: string) {
    const resultParts: string[] = []
    const parser2 = new htmlparser2.Parser({
        ontext: (text) => {
            text = text.trim()
            if(text) resultParts.push(text)
        },
    })
    parser2.write(html)
    parser2.end()
    const result = resultParts.join(' ')

    return result
}

export function isLocationInUs(db: BetterSQLite3Database, location: string) {
    const isInUs = db.select().from(Db.locationClassification)
        .where(D.eq(Db.locationClassification.location, location))
        .get()
        ?.isInUs

    if(isInUs === undefined) {
        db.insert(Db.locationClassification).values({ location, isInUs: '' }).onConflictDoNothing().run()
        return true
    }

    return isInUs !== '0'
}

const currentlyClassifying = new Map<string, Promise<string>>()
export async function isLocationInUsFull(parentLog: L.Log, db: BetterSQLite3Database, location: string) {
    let isInUs = db.select().from(Db.locationClassification)
        .where(D.eq(Db.locationClassification.location, location))
        .get()
        ?.isInUs

    if(isInUs === undefined || isInUs === '') {
        let classifyTask = currentlyClassifying.get(location)
        if(classifyTask === undefined) {
            classifyTask = (async() => {
                await Promise.resolve()

                const log = parentLog.addedCtx('classify')
                try {
                    return await classifyLocationInner(log, db, location)
                }
                catch(err) {
                    log.E([err])
                    return '?'
                }
                finally {
                    currentlyClassifying.delete(location)
                }
            })()
            currentlyClassifying.set(location, classifyTask)
        }
        isInUs = await classifyTask
    }

    return isInUs !== '0'
}

async function classifyLocationInner(log: L.Log, db: BetterSQLite3Database, location: string) {
    const openrouter = new OpenRouter({ apiKey: process.env.OPENROUTER_API_KEY! })
    const generation = await openrouter.chat.send({
        chatRequest: {
            model: 'openai/gpt-5.4-nano',
            reasoning: {
                effort: 'none',
            },
            messages: [
                {
                    role: 'system',
                    content: [{
                        type: 'text',
                        text: 'Below is a location requirement of a job. Does it include a location within continental United States? Reply with "0" if no, "1" if yes, and "?" if unknown or ambiguous.',
                        cacheControl: { type: 'ephemeral' },
                    }],
                },
                {
                    role: 'user',
                    content: location,
                },
            ],
            stream: false,
        }
    })
    log.I('Received generation', [[' ', [generation]], 'extra-details'])
    const result = db.insert(Db.generationResponse)
        .values({ input: JSON.stringify({ v: 1, t: 'classifyLocation', location }), generation: JSON.stringify(generation) })
        .returning({ id: Db.generationResponse.id })
        .get()
    log.I('Inserted as ', [result.id])

    let isInUs = ('' + generation.choices[0].message.content).trim()
    if(!(isInUs === '0' || isInUs === '1' || isInUs === '?')) {
        log.W('Invalid content')
        isInUs = '?'
    }

    db.insert(Db.locationClassification)
        .values({ location, isInUs })
        .onConflictDoUpdate({
            target: Db.locationClassification.location,
            set: { isInUs },
        })
        .run()

    return isInUs
}

export function updateFailCount<
    C extends AnyCompanyTable,
>(
    log: L.Log,
    db: BetterSQLite3Database,
    Company: C,
    company: InferTable<C>,
) {
    const newFailCount = company.failCount + 1
    if(newFailCount >= 10 && company.exists === null) {
        log.I('Marking company inactive after ', [newFailCount], ' fetch fails')
        db.update(Company)
            .set({ exists: 0, tier: 3, failCount: newFailCount } as any)
            .where(D.eq(Company.name, company.name))
            .run()
    }
    else {
        db.update(Company)
            .set({ failCount: newFailCount } as any)
            .where(D.eq(Company.name, company.name))
            .run()
    }
}
