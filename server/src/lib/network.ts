import { Pool, type Dispatcher } from 'undici'

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

function ensureClient(conn: Connection): Pool {
    if (conn.client.destroyed || conn.client.closed) {
        conn.client = new Pool(conn.origin, conn.options)
    }
    return conn.client
}

export async function fetch(
    conn: Connection,
    options: Omit<Dispatcher.RequestOptions, 'origin' | 'opaque'>,
): Promise<Dispatcher.ResponseData> {
    const client = ensureClient(conn)
    try {
        return await client.request({ ...options, origin: conn.origin })
    } catch (err) {
        conn.client.destroy(err as Error).catch(() => {})
        throw err
    }
}
