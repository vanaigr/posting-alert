import 'dotenv/config'

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import * as Db from './lib/db.ts'
import * as L from './lib/log.ts'
import * as C from './lib/common.ts'
import * as Ashbyhq from './boards/ashbyhq.ts'
import * as Lever from './boards/lever.ts'
import * as Greenhouse from './boards/greenhouse.ts'
import * as Bamboohr from './boards/bamboohr.ts'
import * as Zohorecruit from './boards/zohorecruit.ts'
import * as Gem from './boards/gem.ts'
import * as Rippling from './boards/rippling.ts'
import * as Applytojob from './boards/applytojob.ts'
import * as Smartrecruiters from './boards/smartrecruiters.ts'

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

    const sampleSaver = new C.SampleSaver()

    await Promise.race([
        C.runPendingNotificationService(db, mainLog.addedCtx('pending-notif')),
        C.runLocationClassificationService(db, mainLog.addedCtx('loc-classify')),
        // TODO: it should pass the samplers and not saver. Claude...
        Ashbyhq.run(db, mainLog.addedCtx('ashbyhq'), sampleSaver),
        Lever.run(db, mainLog.addedCtx('lever'), sampleSaver),
        Greenhouse.run(db, mainLog.addedCtx('greenhouse'), sampleSaver),
        Bamboohr.run(db, mainLog.addedCtx('bamboohr'), sampleSaver),
        Zohorecruit.run(db, mainLog.addedCtx('zohorecruit'), sampleSaver),
        Gem.run(db, mainLog.addedCtx('gem'), sampleSaver),
        Rippling.run(db, mainLog.addedCtx('rippling'), sampleSaver),
        Applytojob.run(db, mainLog.addedCtx('applytojob'), sampleSaver),
        Smartrecruiters.run(db, mainLog.addedCtx('smartrecruiters'), sampleSaver),
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
