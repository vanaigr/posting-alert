import { Pool, type Dispatcher, type RequestInit, fetch as undiciFetch } from 'undici'

export type Connection = {
    origin: string | URL
    options: Pool.Options | undefined
    client: Pool
}

export function createConnection(origin: string, options?: Pool.Options): Connection {
    return {
        origin,
        options,
        client: new Pool(origin, options),
    }
}

export async function closeConnection(conn: Connection) {
    await conn.client.close().catch(() => {})
}

export function fetch(
    conn: Connection,
    options: Omit<Dispatcher.RequestOptions, 'origin' | 'opaque'>,
): Promise<Dispatcher.ResponseData> {
    return conn.client.request({ ...options, origin: conn.origin })
}

export class BlockedHostError extends Error { constructor(message: string) { super(message) } }

export async function fetch2(
    {
        url,
        allowRedirect,
        maxRedirects,
        ...rest
    } : {
        url: URL | string
        allowRedirect: (url: URL) => boolean
        maxRedirects?: number
    } & RequestInit
) {
    maxRedirects ??= 10
    let current = new URL(url)

    for(let i = 0; i <= maxRedirects; i++) {
        const res = await undiciFetch(current, { ...rest, redirect: 'manual' })

        if(res.status < 300 || res.status >= 400 || !res.headers.has('location')) {
            return res
        }

        try {
            const next = new URL(res.headers.get('location')!, current)
            if(!allowRedirect(next)) {
                throw new BlockedHostError(`Blocked redirect to ${next.hostname}`)
            }
            current = next
        }
        finally {
            await res.body?.cancel().catch(() => {})
        }
    }
    throw new Error('Too many redirects')
}

