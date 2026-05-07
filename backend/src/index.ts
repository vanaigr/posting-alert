import 'dotenv/config'
import crypto from 'node:crypto'

import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import System from 'systeminformation'

import { serve } from '@hono/node-server'
import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import * as L from './lib/log.ts'
import * as U from './lib/util.ts'
import * as Check from '../../scraper/src/check.ts'

let mainLog: L.Log | undefined


const expectedUserId = process.env.TELEGRAM_USER_ID
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN
const allowedOrigin = process.env.ALLOWED_ORIGIN

async function main() {
    const mainLog = L.makeLogger(process.env.LOG_PATH || undefined, undefined)

    process.on('uncaughtException', (err, origin) => {
        mainLog.E('Uncaught exception from ', [origin], ': ', [err])
    })
    process.on('unhandledRejection', (reason, promise) => {
        mainLog.E('Unhandled rejection from ', [promise], ': ', [reason])
    })

    if(!expectedUserId) throw new Error('expected user id is not provided')
    if(!telegramBotToken) throw new Error('expected bot id is not provided')
    if(!allowedOrigin) throw new Error('allowed origin id is not provided')

    const db = drizzle(new Database(process.env.DB_PATH!))

    const app = new Hono()

    app.use('/*', cors({
        origin: [allowedOrigin],
        allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization'],
        credentials: true,
        maxAge: 600,
    }))

    app.get('/stats', async(c) => {
        const log = mainLog.addedCtx('/stats')

        log.I('Serving')

        const validationResult = validate(log, c)
        if(validationResult.status !== 'ok') return c.json({}, { status: 401 })

        const [cpu, mem, fileSystem] = await Promise.all([
            System.currentLoad(),
            System.mem(),
            System.fsSize(),
        ])

        return c.json({
            cpuLoadPercents: cpu.cpus.map(it => it.load),
            ramTotalBytes: mem.total,
            ramFreeBytes: mem.available,
            storageFreeBytes: fileSystem.find(it => it.mount === '/')?.available ?? -1,
        })
    })

    app.get('/check', async(c) => {
        const log = mainLog.addedCtx('/check')

        log.I('Serving')

        const validationResult = validate(log, c)
        if(validationResult.status !== 'ok') return c.json({}, { status: 401 })

        const urlString = c.req.query('url')
        if(urlString !== undefined) {
            let url: URL
            try {
                url = new URL(urlString)
            }
            catch(err) {
                log.E('For ', [urlString], ': ', [err])
                return c.json({}, { status: 400 })
            }

            const _db = db as any

            if(url.hostname === 'jobs.ashbyhq.com') {
                const segments = url.pathname.split('/')
                const companyName = segments[1]
                const jobId = segments[2]
                log.I('Ashbyhq with ', [companyName], ', ', [jobId])
                if(!companyName || !jobId) {
                    return c.json({}, { status: 400 })
                }

                return c.json(Check.ashbyhqGetPostingParams(_db, companyName, jobId))
            }
            else if(url.hostname === 'jobs.lever.co') {
                const segments = url.pathname.split('/')
                const companyName = segments[1]
                const jobId = segments[2]
                log.I('Lever with ', [companyName], ', ', [jobId])
                if(!companyName || !jobId) {
                    return c.json({}, { status: 400 })
                }

                return c.json(Check.leverGetPostingParams(_db, companyName, jobId))
            }
            // TODO: there's also embed url
            else if(url.hostname === 'job-boards.greenhouse.io') {
                const segments = url.pathname.split('/')
                const companyName = segments[1]
                const jobId = segments[3]
                log.I('Greenhouse with ', [companyName], ', ', [jobId])
                if(!companyName || !jobId) {
                    return c.json({}, { status: 400 })
                }

                return c.json(Check.greenhouseGetPostingParams(_db, companyName, jobId))
            }
            else if(url.hostname.endsWith('.bamboohr.com')) {
                const segments = url.pathname.split('/')
                const companyName = url.hostname.slice(0, url.hostname.indexOf('.'))
                const jobId = segments[2]
                log.I('Bamboohr with ', [companyName], ', ', [jobId])
                if(!companyName || !jobId) {
                    return c.json({}, { status: 400 })
                }

                return c.json(Check.bamboohrGetPostingParams(_db, companyName, jobId))
            }
            else if(url.hostname.endsWith('.zohorecruit.com')) {
                const segments = url.pathname.split('/')
                const companyName = url.hostname.slice(0, url.hostname.indexOf('.'))
                const jobId = segments[3]
                log.I('Zohorecruit with ', [companyName], ', ', [jobId])
                if(!companyName || !jobId) {
                    return c.json({}, { status: 400 })
                }

                return c.json(Check.zohorecruitGetPostingParams(_db, companyName, jobId))
            }

            log.I('Unknown url')
            return c.json({}, { status: 404 })
        }
        else {
            const type = c.req.query('type')
            const companyName = c.req.query('companyName')
            const jobId = c.req.query('jobId')
            if(type === undefined || companyName === undefined || jobId === undefined) {
                return c.json({}, { status: 400 })
            }

            const _db = db as any

            if(type === 'ashbyhq') return c.json(Check.ashbyhqGetPostingParams(_db, companyName, jobId))
            if(type === 'lever') return c.json(Check.leverGetPostingParams(_db, companyName, jobId))
            if(type === 'greenhouse') return c.json(Check.greenhouseGetPostingParams(_db, companyName, jobId))
            if(type === 'bamboohr') return c.json(Check.bamboohrGetPostingParams(_db, companyName, jobId))
            if(type === 'zohorecruit') return c.json(Check.zohorecruitGetPostingParams(_db, companyName, jobId))

            log.I('Unknown type')
            return c.json({}, { status: 404 })
        }
    })

    serve(app, (info) => mainLog.I('Serving at ', [info.port]))
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

function validate(log: L.Log, c: Context) {
    const prefix = 'Bearer '

    const auth = c.req.header('Authorization')
    if(!auth?.startsWith(prefix)) {
        log.E('Missing auth header')
        return U.status('error')
    }

    let initData: string
    try {
        initData = Buffer.from(auth.slice(prefix.length), 'base64').toString()
    }
    catch(err) {
        log.E([err])
        return U.status('error')
    }

    return verifyInitData(log, initData)
}

function verifyInitData(log: L.Log, initData: string) {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) {
        log.E('No hash for ', [initData])
        return U.status('error')
    }
    params.delete('hash')

    const dataCheckString = [...params.entries()]
        .map(([k, v]) => [k, v])
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n')

    const secretKey = crypto.createHmac('sha256', 'WebAppData')
        .update(telegramBotToken!)
        .digest()

    const computed = crypto.createHmac('sha256', secretKey)
        .update(dataCheckString)
        .digest('hex')

    const a = Buffer.from(computed, 'hex')
    const b = Buffer.from(hash, 'hex')
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        log.E('Bad hash for ', [initData])
        return U.status('error')
    }

    const userId = params.get('user') ? JSON.parse(params.get('user')!)?.id : undefined
    if(String(userId) !== expectedUserId) {
        log.E('Unexpected user for ', [initData])
        return U.status('error')
    }

    return U.result('ok', { userId })
}
