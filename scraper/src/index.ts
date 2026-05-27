import 'dotenv/config'

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import * as Db from './lib/db.ts'
import * as L from './lib/log.ts'
import * as C from './lib/common.ts'
import * as A from './lib/analytics.ts'
import * as Ashbyhq from './boards/ashbyhq.ts'
import * as Lever from './boards/lever.ts'
import * as Greenhouse from './boards/greenhouse.ts'
import * as Bamboohr from './boards/bamboohr.ts'
import * as Zohorecruit from './boards/zohorecruit.ts'
import * as Gem from './boards/gem.ts'
import * as Rippling from './boards/rippling.ts'
import * as Applytojob from './boards/applytojob.ts'
import * as Smartrecruiters from './boards/smartrecruiters.ts'
import * as Icims from './boards/icims.ts'
import * as Workforcenow from './boards/workforcenow.ts'
import * as Oraclecloud from './boards/oraclecloud.ts'

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

    const dbPath = process.env.DB_PATH
    if(!dbPath) throw new Error('DB_PATH is required')

    const analyticsDbPath = process.env.ANALYTICS_DB_PATH
    if(!analyticsDbPath) throw new Error('ANALYTICS_DB_PATH is required')

    const timezone = process.env.SEARCH_TIMEZONE
    if(!timezone) throw new Error('SEARCH_TIMEZONE is required')

    const db = drizzle(new Database(dbPath))
    Db.migrate(db)

    const analytics = new A.Analytics({
        log: mainLog.addedCtx('analytics'),
        dbPath: analyticsDbPath,
        timezone,
    })

    await Promise.race([
        C.runPendingNotificationService(db, mainLog.addedCtx('pending-notif')),
        C.runLocationClassificationService(db, mainLog.addedCtx('loc-classify')),
        analytics.run(),
        Ashbyhq.run(db, mainLog.addedCtx('ashbyhq'), analytics.createSampler('ashbyhq')),
        //Lever.run(db, mainLog.addedCtx('lever'), analytics.createSampler('lever')),
        //Greenhouse.run(db, mainLog.addedCtx('greenhouse'), analytics.createSampler('greenhouse')),
        //Bamboohr.run(db, mainLog.addedCtx('bamboohr'), analytics.createSampler('bamboohr')),
        //Zohorecruit.run(db, mainLog.addedCtx('zohorecruit'), analytics.createSampler('zohorecruit')),
        Gem.run(db, mainLog.addedCtx('gem'), analytics.createSampler('gem')),
        //Rippling.run(db, mainLog.addedCtx('rippling'), analytics.createSampler('rippling')),
        //Applytojob.run(db, mainLog.addedCtx('applytojob'), analytics.createSampler('applytojob')),
        //Smartrecruiters.run(db, mainLog.addedCtx('smartrecruiters'), analytics.createSampler('smartrecruiters')),
        //Icims.run(db, mainLog.addedCtx('icims'), analytics.createSampler('icims')),
        //Workforcenow.run(db, mainLog.addedCtx('workforcenow'), analytics.createSampler('workforcenow')),
        //Oraclecloud.run(db, mainLog.addedCtx('oraclecloud'), analytics.createSampler('oraclecloud')),
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
