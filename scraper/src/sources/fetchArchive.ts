import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const baseDir = path.resolve(args[0])
const url = args[1]
const matchType = args[2]

const OUTPUT = path.join(baseDir, 'archive-urls.txt')
const STATE = path.join( baseDir, 'archive-urls.state.json')
const MATCH = url//'jobs.lever.co/*'
const BATCH_LIMIT = 50000
const MAX_RETRIES = 20
const BASE_DELAY_MS = 2000

type State = { resumeKey: string | null, done: boolean, batches: number, urls: number }

function loadState(): State {
    if(fs.existsSync(STATE)) {
        return JSON.parse(fs.readFileSync(STATE, 'utf8'))
    }
    return { resumeKey: null, done: false, batches: 0, urls: 0 }
}

function saveState(s: State) {
    fs.writeFileSync(STATE, JSON.stringify(s, null, 2))
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

async function fetchBatch(resumeKey: string | null): Promise<string> {
    const params = new URLSearchParams()
    params.set('url', MATCH)
    params.set('output', 'json')
    if(matchType) params.set('matchType', matchType)
    params.set('fl', 'original')
    params.set('collapse', 'urlkey')
    params.set('showResumeKey', 'true')
    params.set('limit', String(BATCH_LIMIT))
    if(resumeKey) params.set('resumeKey', resumeKey)

    const url = 'https://web.archive.org/cdx/search/cdx?' + params.toString()

    let lastErr: unknown
    for(let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            const ctl = new AbortController()
            const t = setTimeout(() => ctl.abort(), 120_000)
            const res = await fetch(url, { signal: ctl.signal })
            clearTimeout(t)
            if(!res.ok) throw new Error(`HTTP ${res.status}`)
            return await res.text()
        } catch(e) {
            lastErr = e
            const wait = BASE_DELAY_MS// * Math.pow(2, attempt)
            console.error(`batch failed (attempt ${attempt+1}/${MAX_RETRIES}): ${e}; waiting ${wait}ms`)
            await sleep(wait)
        }
    }
    throw new Error(`giving up after ${MAX_RETRIES} retries: ${lastErr}`)
}

function parseBatch(text: string): { urls: string[], resumeKey: string | null } {
    // CDX output=json with showResumeKey returns one JSON array shaped like:
    // [["original"], [url], [url], ..., [url], [], [resumeKey]]
    const trimmed = text.trim()
    if(!trimmed) return { urls: [], resumeKey: null }

    let rows: string[][]
    try {
        rows = JSON.parse(trimmed)
    } catch(e) {
        throw new Error(`failed to parse CDX JSON: ${e}\n--- body start ---\n${trimmed.slice(0, 500)}\n--- end ---`)
    }

    let resumeKey: string | null = null
    let end = rows.length
    // Trailing pattern: [], [resumeKey]
    if(end >= 2 && rows[end - 2].length === 0 && rows[end - 1].length === 1) {
        resumeKey = rows[end - 1][0]
        end -= 2
    }

    const urls: string[] = []
    for(let i = 0; i < end; i++) {
        const r = rows[i]
        if(!r || r.length === 0) continue
        if(i === 0 && r[0] === 'original') continue
        urls.push(r[0])
    }
    return { urls, resumeKey }
}

async function main() {
    const state = loadState()
    if(state.done) {
        console.log('already done according to state file; delete', STATE, 'to restart')
        return
    }

    const out = fs.createWriteStream(OUTPUT, { flags: 'a' })

    try {
        while(!state.done) {
            console.log(`fetching batch ${state.batches + 1} (resumeKey=${state.resumeKey ?? 'none'})`)
            const text = await fetchBatch(state.resumeKey)
            const { urls, resumeKey } = parseBatch(text)

            for(const u of urls) out.write(u + '\n')

            state.batches++
            state.urls += urls.length
            state.resumeKey = resumeKey
            if(!resumeKey || urls.length === 0) state.done = true
            saveState(state)

            console.log(`  +${urls.length} urls (total ${state.urls}); done=${state.done}`)

            if(!state.done) await sleep(1000)
        }
        console.log(`finished: ${state.urls} urls across ${state.batches} batches -> ${OUTPUT}`)
    } finally {
        out.end()
    }
}

main().catch(e => {
    console.error('fatal:', e)
    process.exit(1)
})
