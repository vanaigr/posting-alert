import 'dotenv/config'
import crypto from 'node:crypto'

import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as D from 'drizzle-orm'
import System from 'systeminformation'

import { serve } from '@hono/node-server'
import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import * as T from './lib/temporal.ts'
import * as L from './lib/log.ts'
import * as U from './lib/util.ts'
import * as Db from './lib/db.ts'
import * as Check from '../../scraper/src/check.ts'

let mainLog: L.Log | undefined

const searchTimezone = process.env.SEARCH_TIMEZONE
const expectedUserId = process.env.TELEGRAM_USER_ID
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN
const allowedOrigin = process.env.ALLOWED_ORIGIN
const telegramWebhookSecres = process.env.TELEGRAM_WEBHOOK_SECRET

async function main() {
    const mainLog = L.makeLogger(process.env.LOG_PATH || undefined, undefined)

    process.on('uncaughtException', (err, origin) => {
        mainLog.E('Uncaught exception from ', [origin], ': ', [err])
    })
    process.on('unhandledRejection', (reason, promise) => {
        mainLog.E('Unhandled rejection from ', [promise], ': ', [reason])
    })

    if(!searchTimezone) throw new Error('search timezone is not provided')
    if(!expectedUserId) throw new Error('expected user id is not provided')
    if(!telegramBotToken) throw new Error('expected bot id is not provided')
    if(!allowedOrigin) throw new Error('allowed origin id is not provided')
    if(!telegramWebhookSecres) throw new Error('telegram webhook secret is not provided')

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

        const todayBegin = T.Now.instant().toZonedDateTimeISO(searchTimezone).startOfDay().toInstant().epochMilliseconds / 1000

        const reactions = db.select().from(Db.messageReactions)
            .where(D.gte(D.sql<number>`json_extract(${Db.messageReactions.data}, '$.date')`, todayBegin))
            .all()
        const todayReactions: Record<string, number> = {}
        for(const reaction of reactions) {
            const data = JSON.parse(reaction.data) as MessageReactionUpdated
            for(const it of data.new_reaction) {
                if(it.type !== 'emoji') continue
                todayReactions[it.emoji] = (todayReactions[it.emoji] ?? 0) + 1
            }
        }

        return c.json({
            cpuLoadPercents: cpu.cpus.map(it => it.load),
            ramTotalBytes: mem.total,
            ramFreeBytes: mem.available,
            storageFreeBytes: fileSystem.find(it => it.mount === '/')?.available ?? -1,
            todayReactions,
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
                if(url.pathname.startsWith('/embed/job_app')) {
                    const companyName = url.searchParams.get('for')
                    const jobId = url.searchParams.get('token')
                    log.I('Greenhouse embed with ', [companyName], ', ', [jobId])
                    if(!companyName || !jobId) {
                        return c.json({}, { status: 400 })
                    }

                    return c.json(Check.greenhouseGetPostingParams(_db, companyName, jobId))
                }
                else {
                    const segments = url.pathname.split('/')
                    const companyName = segments[1]
                    const jobId = segments[3]
                    log.I('Greenhouse with ', [companyName], ', ', [jobId])
                    if(!companyName || !jobId) {
                        return c.json({}, { status: 400 })
                    }

                    return c.json(Check.greenhouseGetPostingParams(_db, companyName, jobId))
                }
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
            else if(url.hostname === 'jobs.gem.com') {
                const segments = url.pathname.split('/')
                const companyName = segments[1]
                const jobId = segments[2]
                log.I('Gem with ', [companyName], ', ', [jobId])
                if(!companyName || !jobId) {
                    return c.json({}, { status: 400 })
                }

                return c.json(Check.gemGetPostingParams(_db, companyName, jobId))
            }
            else if(url.hostname === 'ats.rippling.com') {
                const segments = url.pathname.split('/')
                const companyName = segments[1]
                const jobId = segments[3]
                log.I('Rippling with ', [companyName], ', ', [jobId])
                if(!companyName || !jobId) {
                    return c.json({}, { status: 400 })
                }

                return c.json(Check.ripplingGetPostingParams(_db, companyName, jobId))
            }
            else if(url.hostname.endsWith('.applytojob.com')) {
                const companyName = url.hostname.slice(0, url.hostname.indexOf('.'))
                const jobId = url.pathname
                log.I('Applytojob with ', [companyName], ', ', [jobId])
                if(!companyName || !jobId) {
                    return c.json({}, { status: 400 })
                }

                return c.json(Check.applytojobGetPostingParams(_db, companyName, jobId))
            }
            else if(url.hostname.endsWith('.icims.com')) {
                const segments = url.pathname.split('/')
                const companyName = url.hostname.slice(0, url.hostname.indexOf('.'))
                const jobId = segments[2]
                log.I('Icims with ', [companyName], ', ', [jobId])
                if(!companyName || !jobId) {
                    return c.json({}, { status: 400 })
                }

                return c.json(Check.icimsGetPostingParams(_db, companyName, jobId))
            }
            else if(url.hostname === 'jobs.smartrecruiters.com') {
                const segments = url.pathname.split('/')
                const jobId = segments[2]?.split('-')[0]
                log.I('Smartrecruiters with ', [jobId])
                if(!jobId) {
                    return c.json({}, { status: 400 })
                }

                return c.json(Check.smartrecruitersGetPostingParams(_db, jobId))
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
            if(type === 'gem') return c.json(Check.gemGetPostingParams(_db, companyName, jobId))
            if(type === 'rippling') return c.json(Check.ripplingGetPostingParams(_db, companyName, jobId))
            if(type === 'applytojob') return c.json(Check.applytojobGetPostingParams(_db, companyName, jobId))
            if(type === 'icims') return c.json(Check.icimsGetPostingParams(_db, companyName, jobId))
            if(type === 'smartrecruiters') return c.json(Check.smartrecruitersGetPostingParams(_db, jobId))

            log.I('Unknown type')
            return c.json({}, { status: 404 })
        }
    })


    app.post('/api/telegram', async(c) => {
        const log = mainLog.addedCtx('/api/telegram')

        const token = c.req.header('x-telegram-bot-api-secret-token')
        if(token !== telegramWebhookSecres) {
            log.W('Unexpected webhook token ', [token])
            return new Response('', { status: 401 })
        }

        const body = await c.req.json()
        log.I('Serving', [[' ', body], 'extra-details'])
        if(body.message_reaction !== undefined) {
            log.I('Handling reaction')
            const reaction = body.message_reaction as MessageReactionUpdated

            if(String(reaction.user?.id) !== expectedUserId) {
                log.E('Unexpected user for ', [reaction])
                // NOTE: Auth error, but the message itself is handled successfully
                return c.json({})
            }

            db.insert(Db.messageReactions)
                .values({ messageId: reaction.message_id, data: JSON.stringify(reaction) })
                .onConflictDoUpdate({
                    target: Db.messageReactions.messageId,
                    set: { data: JSON.stringify(reaction) },
                })
                .run()
        }
        else if(body.message !== undefined) {
            const message = body.message as Message

            if(String(message.from?.id) !== expectedUserId) {
                log.E('Unexpected user for ', [message])
                // NOTE: Auth error, but the message itself is handled successfully
                return c.json({})
            }

            const text = message.text ?? ''
            const command = '/ban'
            if(text.startsWith(command)) {
                log.I('Handling /ban')
                const rest = text.slice(command.length)
                const nlIndex = rest.indexOf('\n')

                let companyName: string
                let reason: string
                if(nlIndex === -1) {
                    companyName = rest
                    reason = ''
                }
                else {
                    companyName = rest.slice(0, nlIndex)
                    reason = rest.slice(nlIndex + 1)
                }

                companyName = companyName.trim()
                reason = reason.trim()

                db.insert(Db.companyBans)
                    .values({ companyName, reason })
                    .run()
            }
            else {
                log.W('Skipping unknown message')
            }
        }
        else {
            log.W('Skipping update')
        }

        return c.json({})
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


type User = {
    id: number
    first_name: string
    last_name?: string
    username?: string
}
type ReactionType = { type: 'emoji', emoji: string }
| { type: 'custom_emoji', custom_emoji_id: string }
| { type: 'paid' }
type MessageReactionUpdated = {
    //chat: Chat
    message_id: number
    user?: User
    //actor_chat?: Chat
    date: number
    new_reaction: ReactionType[]
}
type Message = {
    message_id: number
    //chat: Chat
    from?: User
    date: number
    edit_date?: number
    reply_to_message?: Message

    text?: string
    caption?: string
}
