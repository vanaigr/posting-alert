import fs from 'node:fs'
import path from 'node:path'
import 'dotenv/config'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import * as Db from './db.ts'

export function populate(db: BetterSQLite3Database) {
    const companyNames: string[] = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'sources', 'companyNames.json')).toString())

    db.insert(Db.company)
        .values(companyNames.map(it => ({ name: it, checkedEpochMs: null, exists: null })))
        .execute()
}

if(import.meta.main) {
    const db = drizzle(new Database(process.env.ASHBYHQ_DB_PATH!))
    Db.migrate(db)
    populate(db)
    console.log('done')
}
