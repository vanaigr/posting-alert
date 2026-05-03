import { Client, type Dispatcher } from 'undici'

export type Connection = {
    origin: string | URL
    options: Client.Options | undefined
    client: Client
}

export function createConnection(origin: string, options?: Client.Options): Connection {
    return {
        origin,
        options,
        client: new Client(origin, options),
    }
}

export async function closeConnection(conn: Connection) {
    await conn.client.close().catch(() => {})
}

function ensureClient(conn: Connection): Client {
    if (conn.client.destroyed || conn.client.closed) {
        conn.client = new Client(conn.origin, conn.options)
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
        // Connection-level failure: drop the socket so the next call reconnects.
        conn.client.destroy(err as Error).catch(() => {})
        throw err
    }
}
