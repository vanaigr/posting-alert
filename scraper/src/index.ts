import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import * as Db from './lib/db.ts'
import * as L from './lib/log.ts'
import * as U from './lib/util.ts'
import * as Ashbyhq from './ashbyhq/run.ts'
import * as Lever from './lever/run.ts'
import * as Greenhouse from './greenhouse/run.ts'
import * as Bamboohr from './bamboohr/run.ts'
import * as Zohorecruit from './zohorecruit.ts'
import * as C from './common.ts'

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
        Ashbyhq.run(db, mainLog.addedCtx('ashbyhq')),
        Lever.run(db, mainLog.addedCtx('lever')),
        Greenhouse.run(db, mainLog.addedCtx('greenhouse')),
        Bamboohr.run(db, mainLog.addedCtx('bamboohr')),
        Zohorecruit.run(db, mainLog.addedCtx('zohorecruit')),
        C.runPendingNotificationService(db, mainLog.addedCtx('pending-notif')),
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
