import * as D from 'drizzle-orm'
import { type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import * as L from './log.ts'
import * as T from './temporal.ts'
import * as Db from './db.ts'

export async function timedAsync<const R, const A extends unknown[]>(
  fn: (...args: A) => R,
  ...args: A
): Promise<[Awaited<R>, number]> {
  const b = performance.now();
  const result = await fn(...args);
  const e = performance.now();
  return [result, Math.round((e - b) * 100) / 100];
}

export function envVarValid(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}

type RequestParam = Omit<RequestInit, 'signal' | 'log' | 'url'> & { url: URL; log: L.Log };
export async function request<R = unknown>({ url, log, ...options }: RequestParam) {
  try {
    log.I('Fetching ', [url.toString()])
    const resp = await fetch(url, { ...options });
    if (!resp.ok) {
      const bodyMessage: L.Message = await resp.text().then(
        (it) => ['Body: ', [it]],
        (e) => ['Body error: ', [e]],
      );
      log.E('Response status: ', [resp.status], '\n', ...bodyMessage);
      return status('error.response');
    }
    return result('ok', (await resp.json()) as R);
  } catch (err) {
    log.E('Unexpected response error: ', [err]);
    return status('error.response');
  }
}

export type Result<S, D> = { status: S; data: D };
export function result<const S, D>(status: S, data: D): Result<S, D> {
  return { status, data };
}
export function status<const S, D>(status: S): Result<S, undefined> {
  return { status, data: undefined };
}

export function delay(until: T.Instant) {
  return new Promise((s) => {
    const check = () => {
      const diff = until.since(T.Now.instant());
      if (diff.sign <= 0) {
        s(undefined);
        return;
      }
      setTimeout(check, diff.total('milliseconds'));
    };
    check();
  });
}

// NOTE: use this instead of `Promise.all` since in the case of an
// unexpected error, you rarely want other tasks to still be executing.
export async function all<T extends readonly unknown[] | []>(
  values: T,
): Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }> {
  await Promise.allSettled(values);
  // eslint-disable-next-line local/no-promise-all
  return await Promise.all(values);
}

export function getHash(...fields: unknown[]) {
  let result = '';
  for (const it of fields) {
    const el = '' + it;
    result += el.length.toString(36) + '$' + el;
  }
  return result;
}

export function regexEscape(str: string) {
    // @ts-ignore
    return RegExp.escape(str)
}

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
        await delay(T.Now.instant().add({ seconds: 10 }))

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

/** Works as you would actually want. End-exclusive, no magic */
export function basedSlice<T extends Array<unknown> | string>(it: T, begin: number, end?: number): T { return it.slice(Math.max(begin, 0), end !== undefined ? Math.max(end, 0) : undefined) as T }
