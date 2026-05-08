import * as D from 'drizzle-orm'
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import * as L from './lib/log.ts'
import * as U from './lib/util.ts'
import * as T from './lib/temporal.ts'
import * as N from './lib/network.ts'
import * as Db from './lib/db.ts'

type InferTable<T> = T extends infer V ? V extends D.Table ? D.InferSelectModel<V> : never : never

export type AnyCompanyTable = typeof Db.aCompany | typeof Db.lCompany | typeof Db.gCompany
    | typeof Db.bamboohrCompany | typeof Db.zohorecruitCompany | typeof Db.gemCompany
export type AnyComany = InferTable<AnyCompanyTable>

export type AnyJobTable = typeof Db.aJob | typeof Db.lJob | typeof Db.gJob
    | typeof Db.bamboohrJob | typeof Db.zohorecruitJob | typeof Db.gemJob
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

export function evaluateTiers<C extends { name: string }, J extends { companyName: string }>(
    log: L.Log,
    db: BetterSQLite3Database,
    Company: any,
    Job: any,
    calculateTier: (company: C, jobs: J[]) => number,
) {
    const tierZero = db.select().from(Company).where(D.eq(Company.tier, 0)).all() as C[]
    if(tierZero.length === 0) return

    log.I('Recalculating tier for ', [tierZero.length], ' companies')

    const jobsByCompany = new Map<string, J[]>()
    // NOTE: this function is intended to be invoked when tier'ing changes and all companies
    // need to be reevaluated, so querying everything is fine.
    for(const job of db.select().from(Job).all() as J[]) {
        const arr = jobsByCompany.get(job.companyName) ?? []
        arr.push(job)
        jobsByCompany.set(job.companyName, arr)
    }

    const tier1: string[] = []
    const tier2: string[] = []
    const tier3: string[] = []
    for(const company of tierZero) {
        const tier = calculateTier(company, jobsByCompany.get(company.name) ?? [])
        if(tier === 1) tier1.push(company.name)
        else if(tier === 2) tier2.push(company.name)
        else tier3.push(company.name)
    }

    db.transaction(tx => {
        if(tier1.length > 0) tx.update(Company).set({ tier: 1 }).where(D.inArray(Company.name, tier1)).run()
        if(tier2.length > 0) tx.update(Company).set({ tier: 2 }).where(D.inArray(Company.name, tier2)).run()
        if(tier3.length > 0) tx.update(Company).set({ tier: 3 }).where(D.inArray(Company.name, tier3)).run()
    })

    log.I([tier1.length], ', ', [tier2.length], ', ', [tier3.length])
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
                D.eq(Company.exists, 1),
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
