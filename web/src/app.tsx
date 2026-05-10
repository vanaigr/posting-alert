import R from 'react'
import * as Recharts from 'recharts'

type Stats = {
    cpuLoadPercents: number[]
    ramTotalBytes: number
    ramFreeBytes: number
    storageFreeBytes: number // -1 - N/A
}

type Sample = {
    t: number
    cpu1: number
    cpu2: number
    ram: number
}

export type Check = {
    company: {
        exists: number | null
        tier: number
        checkEpochMs: number | null
        failCount: number | undefined
    } | null
    job: {
        fetchedEpochMs: number | null
        publishedEpochMs: number | null
        locationRelevant: boolean
        locationDesired: boolean
        jobRelevant: boolean
        jobDesired: boolean
    } | null
}

type CheckState =
    | { status: 'idle' }
    | { status: 'pending' }
    | { status: 'error', error: string }
    | { status: 'ok', data: Check }

const MAX_SAMPLES = 30

const TYPES = ['ashbyhq', 'lever', 'greenhouse', 'bamboohr', 'zohorecruit', 'gem', 'rippling'] as const
type Type = typeof TYPES[number]

function formatBytes(bytes: number): string {
    if(bytes < 0) return 'N/A'
    const gb = bytes / (1024 * 1024 * 1024)
    if(gb >= 1) return gb.toFixed(1) + ' GB'
    const mb = bytes / (1024 * 1024)
    return mb.toFixed(1) + ' MB'
}

function MiniChart({ data, dataKey, domain, color }: {
    data: Sample[]
    dataKey: keyof Sample
    domain: [number | 'auto', number | 'auto']
    color: string
}) {
    return <div className='h-24 w-full'>
        <Recharts.ResponsiveContainer width='100%' height='100%'>
            <Recharts.LineChart data={data} margin={{ top: 4, right: 4, left: 4, bottom: 4 }}>
                <Recharts.YAxis domain={domain} tick={false} width={1}/>
                <Recharts.XAxis dataKey='t' tick={false} height={1}/>
                <Recharts.Line
                    type='monotone'
                    dataKey={dataKey}
                    stroke={color}
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                />
            </Recharts.LineChart>
        </Recharts.ResponsiveContainer>
    </div>
}

export default function App() {
    const [samples, setSamples] = R.useState<Sample[]>([])
    const [latest, setLatest] = R.useState<Stats | null>(null)
    const [statsError, setStatsError] = R.useState<string | null>(null)

    const [isUrl, setIsUrl] = R.useState(true)
    const [input, setInput] = R.useState('')
    const [type, setType] = R.useState<Type>('ashbyhq')
    const [companyName, setCompanyName] = R.useState('')
    const [jobId, setJobId] = R.useState('')
    const [check, setCheck] = R.useState<CheckState>({ status: 'idle' })

    const initData = (window as any).Telegram?.WebApp?.initData

    R.useEffect(() => {
        let cancelled = false
        let timer: ReturnType<typeof setTimeout> | null = null

        const tick = async() => {
            if(!initData) return

            try {
                const url = new URL('stats', import.meta.env.VITE_SERVER_URL)
                const response = await fetch(url, {
                    headers: {
                        Authorization: 'Bearer ' + btoa(initData),
                    },
                })
                if(!response.ok) throw new Error(`HTTP ${response.status}`)
                const data: Stats = await response.json()
                if(cancelled) return
                setLatest(data)
                setStatsError(null)
                setSamples(prev => {
                    const next: Sample = {
                        t: Date.now(),
                        cpu1: data.cpuLoadPercents[0] ?? 0,
                        cpu2: data.cpuLoadPercents[1] ?? 0,
                        ram: data.ramFreeBytes,
                    }
                    const arr = [...prev, next]
                    if(arr.length > MAX_SAMPLES) arr.splice(0, arr.length - MAX_SAMPLES)
                    return arr
                })
            }
            catch(err) {
                if(cancelled) return
                setStatsError(err instanceof Error ? err.message : String(err))
            }
            finally {
                if(!cancelled) timer = setTimeout(tick, 1000)
            }
        }

        tick()

        return () => {
            cancelled = true
            if(timer !== null) clearTimeout(timer)
        }
    }, [])

    const send = async() => {
        if(!initData) return

        setCheck({ status: 'pending' })
        try {
            const url = new URL('check', import.meta.env.VITE_SERVER_URL)
            if(isUrl) {
                url.searchParams.set('url', input.trim())
            }
            else {
                url.searchParams.set('type', type)
                url.searchParams.set('companyName', companyName.trim())
                url.searchParams.set('jobId', jobId.trim())
            }
            const response = await fetch(url, {
                headers: {
                    Authorization: 'Bearer ' + btoa(initData),
                },
            })
            if(!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text().catch(() => '')}`)
            const data: Check = await response.json()
            setCheck({ status: 'ok', data })
        }
        catch(err) {
            setCheck({ status: 'error', error: err instanceof Error ? err.message : String(err) })
        }
    }

    if(!initData) {
        return <div>Not running as a Telegram app</div>
    }

    return <div className='flex-1 bg-slate-900 text-slate-100 p-3 flex flex-col gap-4'>
        <section className='flex flex-col gap-3'>
            {statsError && <div className='text-xs text-red-400'>Stats: {statsError}</div>}

            <div>
                <div className='flex gap-2 text-sm mb-1'>
                    <span className='font-bold'>CPU 1:</span>
                    <span className='tabular-nums'>{latest ? (latest.cpuLoadPercents[0] ?? 0).toFixed(1) + '%' : '—'}</span>
                </div>
                <MiniChart data={samples} dataKey='cpu1' domain={[0, 100]} color='#60a5fa' />
            </div>

            <div>
                <div className='flex gap-2 text-sm mb-1'>
                    <span className='font-bold'>CPU 2:</span>
                    <span className='tabular-nums'>{latest ? (latest.cpuLoadPercents[1] ?? 0).toFixed(1) + '%' : '—'}</span>
                </div>
                <MiniChart data={samples} dataKey='cpu2' domain={[0, 100]} color='#34d399' />
            </div>

            <div>
                <div className='flex gap-2 text-sm mb-1'>
                    <span className='font-bold'>Free RAM:</span>
                    <span className='tabular-nums'>{latest ? formatBytes(latest.ramFreeBytes) + ' / ' + formatBytes(latest.ramTotalBytes) : '—'}</span>
                </div>
                <MiniChart data={samples} dataKey='ram' domain={[0, latest?.ramTotalBytes ?? 'auto']} color='#fbbf24' />
            </div>

            <div className='flex gap-2 text-sm'>
                <span className='font-bold'>Free Storage:</span>
                <span className='tabular-nums'>{latest ? formatBytes(latest.storageFreeBytes) : '—'}</span>
            </div>
        </section>

        <section className='flex flex-col gap-2 mt-8'>
            <div className='flex gap-2'>
                <button
                    className={'flex-1 px-4 py-2 rounded text-sm font-medium bg-blue-400' + (isUrl ? '' : ' opacity-50')}
                    onClick={() => setIsUrl(true)}
                >
                    URL
                </button>
                <button
                    className={'flex-1 px-4 py-2 rounded text-sm font-medium bg-blue-400' + (!isUrl ? '' : ' opacity-50')}
                    onClick={() => setIsUrl(false)}
                >
                    Parts
                </button>
            </div>

            <div className='flex flex-col gap-2'>
                {isUrl && (
                    <input
                        type='text'
                        value={input}
                        onChange={e => setInput(e.target.value)}
                        placeholder='Job URL'
                        className='flex-1 min-w-0 px-3 py-2 rounded bg-slate-800 border border-slate-700 text-sm focus:outline-none focus:border-blue-500'
                    />
                )}
                {!isUrl && <>
                    <select
                        value={type}
                        onChange={e => setType(e.target.value as Type)}
                        className='px-3 py-2 rounded bg-slate-800 border border-slate-700 text-sm focus:outline-none focus:border-blue-500'
                    >
                        {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                    <input
                        type='text'
                        value={companyName}
                        onChange={e => setCompanyName(e.target.value)}
                        placeholder='Company name'
                        className='flex-1 min-w-0 px-3 py-2 rounded bg-slate-800 border border-slate-700 text-sm focus:outline-none focus:border-blue-500'
                    />
                    <input
                        type='text'
                        value={jobId}
                        onChange={e => setJobId(e.target.value)}
                        placeholder='Job ID'
                        className='flex-1 min-w-0 px-3 py-2 rounded bg-slate-800 border border-slate-700 text-sm focus:outline-none focus:border-blue-500'
                    />
                </>}
                <button
                    onClick={send}
                    disabled={check.status === 'pending' || (isUrl ? !input.trim() : (!companyName.trim() || !jobId.trim()))}
                    className='px-4 py-2 rounded bg-blue-600 text-sm font-medium disabled:opacity-50 active:bg-blue-700'
                >
                    Send
                </button>
            </div>

            <div className='rounded bg-slate-800 border border-slate-700 p-3 text-sm min-h-[8rem]'>
                {check.status === 'idle' && <span className='text-slate-500'>Enter a URL and tap Send.</span>}
                {check.status === 'pending' && <span className='text-slate-400'>Checking…</span>}
                {check.status === 'error' && <span className='text-red-400 break-all'>{check.error}</span>}
                {check.status === 'ok' && <CheckResult data={check.data} />}
            </div>
        </section>
    </div>
}

function CheckResult({ data }: { data: Check }) {
    const { company, job } = data
    return <div className='flex flex-col gap-3'>
        <div>
            <div className='font-medium mb-1'>Company</div>
            {!company
                ? <div className='text-slate-400'>Not in DB</div>
                : <ul className='text-xs space-y-0.5 text-slate-300'>
                    <li>Exists: {company.exists === null ? 'UNKNOWN' : company.exists ? 'YES' : 'NO'}</li>
                    <li>Tier: {company.tier}</li>
                    <li>Checked: {company.checkEpochMs === null ? '—' : new Date(company.checkEpochMs).toLocaleString()}</li>
                    {company.failCount !== undefined && <li>Fail count: {company.failCount}</li>}
                </ul>
            }
        </div>
        <div>
            <div className='font-medium mb-1'>Job</div>
            {!job
                ? <div className='text-slate-400'>Not in DB</div>
                : <ul className='text-xs space-y-0.5 text-slate-300'>
                    <li>Fetched: {job.fetchedEpochMs == null ? '—' : new Date(job.fetchedEpochMs).toLocaleString()}</li>
                    <li>Published: {job.publishedEpochMs == null ? '—' : new Date(job.publishedEpochMs).toLocaleString()}</li>
                    <li>Location relevant: {String(job.locationRelevant)}</li>
                    <li>Location desired: {String(job.locationDesired)}</li>
                    <li>Job relevant: {String(job.jobRelevant)}</li>
                    <li>Job desired: {String(job.jobDesired)}</li>
                </ul>
            }
        </div>
    </div>
}
