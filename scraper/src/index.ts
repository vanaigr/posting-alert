import 'dotenv/config'

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import * as Db from './lib/db.ts'
import * as L from './lib/log.ts'
import * as C from './common.ts'
import * as Ashbyhq from './boards/ashbyhq.ts'
import * as Lever from './boards/lever.ts'
import * as Greenhouse from './boards/greenhouse.ts'
import * as Bamboohr from './boards/bamboohr.ts'
import * as Zohorecruit from './boards/zohorecruit.ts'
import * as Gem from './boards/gem.ts'
import * as Rippling from './boards/rippling.ts'
import * as Applytojob from './boards/applytojob.ts'

let mainLog: L.Log | undefined

// TODO: scan new companies first but keep track on the number of failures and disable if they keep failing
// I don't need that since I already scanned all the companies for the currently added boards.

async function main() {
    const mainLog = L.makeLogger(process.env.LOG_PATH || undefined, undefined)

    process.on('uncaughtException', (err, origin) => {
        mainLog.E('Uncaught exception from ', [origin], ': ', [err])
    })
    process.on('unhandledRejection', (reason, promise) => {
        mainLog.E('Unhandled rejection from ', [promise], ': ', [reason])
    })

    const db = drizzle(new Database(process.env.DB_PATH!))
    Db.migrate(db)

    await Promise.race([
        C.runPendingNotificationService(db, mainLog.addedCtx('pending-notif')),
        C.runLocationClassificationService(db, mainLog.addedCtx('loc-classify')),
        Ashbyhq.run(db, mainLog.addedCtx('ashbyhq')),
        Lever.run(db, mainLog.addedCtx('lever')),
        Greenhouse.run(db, mainLog.addedCtx('greenhouse')),
        Bamboohr.run(db, mainLog.addedCtx('bamboohr')),
        Zohorecruit.run(db, mainLog.addedCtx('zohorecruit')),
        Gem.run(db, mainLog.addedCtx('gem')),
        Rippling.run(db, mainLog.addedCtx('rippling')),
        Applytojob.run(db, mainLog.addedCtx('applytojob')),
    ])

    mainLog.W('A sub-task exited. Restarting')
}

try {
    await main()
}
catch(err) {
    if(mainLog) mainLog.E([err])
    else console.error(err)
}
finally {
    await mainLog?.flushMessages()
}

process.exit(0)
