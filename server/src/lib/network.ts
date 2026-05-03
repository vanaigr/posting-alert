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

export function fetch(
    conn: Connection,
    options: Omit<Dispatcher.RequestOptions, 'origin' | 'opaque'>,
): Promise<Dispatcher.ResponseData> {
    return conn.client.request({ ...options, origin: conn.origin })
}
