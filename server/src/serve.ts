import 'dotenv/config'
import Database from 'better-sqlite3'
import * as D from 'drizzle-orm'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as H from 'hono'
import { serve } from '@hono/node-server'
import { cors } from 'hono/cors'

import * as U from './lib/util.ts'
import * as L from './lib/log.ts'
import * as T from './lib/temporal.ts'
import * as Db from './ashbyhq/db.ts'

import * as Tiers from './ashbyhq/tier.ts'

async function main() {
    const mainLog = L.makeLogger(process.env.SERVE_LOG_PATH || undefined, undefined)

    const db = drizzle(new Database(process.env.ASHBYHQ_DB_PATH!))
    Db.migrate(db)

    const app = new H.Hono()

    app.use('*', cors({
        origin: '*',
        allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization'],
    }))

    if(!process.env.BEARER) {
        throw new Error('Missing bearer token')
    }

    app.get('/jobs', (q) => {
        mainLog.I('GET /jobs')

        const authStatus = getAuthStatus(q)
        if(authStatus.status !== 'ok') {
            mainLog.W('Auth: ', [authStatus.data.message])
            return q.json(authStatus.data, 401)
        }

        const jobs = db.select()
            .from(Db.toReview)
            .innerJoin(Db.job, D.eq(Db.toReview.id, Db.job.id))
            .all()

        return q.json(jobs.map(it => {
            const shortInfo = JSON.parse(it.job.shortInfo ?? '{}')

            const info = {
                id: it.job.id,
                title: shortInfo.title,
                locations: Tiers.getJobLocation(it.job),
                workplaceType: shortInfo.workplaceType,
            }

            const desired = Tiers.isTitleDesired(info)
                && Tiers.isLocationRelevant(info)
                && Tiers.isRelevantLocationDesired(info)

            return { ...it.job, desired }
        }))
    })

    app.delete('/jobs/:id', (q) => {
        const id = q.req.param('id')

        mainLog.I('DELETE /jobs/:id for ', [id])

        const authStatus = getAuthStatus(q)
        if(authStatus.status !== 'ok') {
            mainLog.W('Auth: ', [authStatus.data.message])
            return q.json(authStatus.data, 401)
        }

        if(!id) {
            return q.json(authStatus.data, 400)
        }

        db.delete(Db.toReview).where(D.eq(Db.toReview.id, id)).run()

        return q.json({})
    })

    serve({
        fetch: app.fetch,
        port: 3000,
    })
    mainLog.I('Listening on 3000')
}

const authPrefix = 'Bearer '
function getAuthStatus(q: H.Context) {
    const auth = q.req.header('Authorization') ?? ''
    if(!auth.startsWith(authPrefix)) {
        return U.result('error', { message: 'Missing Authorization header' })
    }
    if(auth.substring(authPrefix.length) !== process.env.BEARER) {
        return U.result('error', { message: 'Invalid authorization' })
    }

    return U.status('ok')
}

await main()
