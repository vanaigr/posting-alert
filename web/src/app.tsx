import R from 'react'

type InfoResult<T> = { status: 'pending' } | { status: 'error' } | { status: 'ok', data: T }

// /stats
type Stats = {
    cpuLoadPercents: number[]
    ramFreeBytes: number,
    storageFreeBytes: number // -1 - N/A
}

// /check?url=<url>
export type Check = {
    company: {
        exists: number | null
        tier: number
        checkEpochMs: number | null
        failCount: number | undefined
    }
    job: {
        fetchedEpochMs: number | null
        locationRelevant: boolean
        locationDesired: boolean
        jobRelevant: boolean
        jobDesired: boolean
    }
}

export default function App() {
    /*
    const [info, setInfo] = R.useState<InfoResult>({ status: 'pending' })

    R.useEffect(() => {
        const controller = new AbortController()

        ;(async() => {
            console.log(import.meta.env)
            //const url = new URL('check', import.meta.env.VITE_SERVER_URL)
            //url.searchParams.set('url', 'https://job-boards.greenhouse.io/amwell/jobs/4240721009')
            const url = new URL('stats', import.meta.env.VITE_SERVER_URL)

            try {
                const response = await fetch(url, { signal: controller.signal })
                if(!response.ok) throw new Error(`Failed with ${response.status}: ${await response.text().catch(it => it)}`)

                const result = await response.json()
                setInfo({ status: 'ok', data: result })
            }
            catch(err) {
                if(controller.signal.aborted) return
                console.error(err)
                setInfo({ status: 'error' })
            }
        })()

        return () => {
            controller.abort()
        }
    }, [])
    */

    return <div className='bg-red-200'>
    </div>
}
