import * as L from './log.ts'
import * as T from './temporal.ts'

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

export async function sendMessage(log: L.Log, message: string) {
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
    }
    catch(err) {
        log.E('While sending notification: ', [err])
    }
}
