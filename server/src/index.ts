import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import * as Db from './lib/db.ts'
import * as L from './lib/log.ts'
import * as A from './ashbyhq/run.ts'

async function main() {
    const mainLog = L.makeLogger(process.env.LOG_PATH || undefined, undefined)

    const db = drizzle(new Database(process.env.ASHBYHQ_DB_PATH!))
    Db.migrate(db)

    await Promise.race([
        A.run(db, mainLog.addedCtx('ashbyhq')),
    ])

    mainLog.W('A sub-task exited. Restarting')
}

await main()
process.exit(0)
