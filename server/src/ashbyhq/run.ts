import 'dotenv/config'
import Database from 'better-sqlite3'
import * as D from 'drizzle-orm'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import * as U from '../lib/util.ts'
import * as L from '../lib/log.ts'
import * as T from '../lib/temporal.ts'
import * as Db from './db.ts'
import { populate } from './populate.ts'

async function main() {
    const mainLog = L.makeLogger(undefined, undefined)

    const db = drizzle(new Database(process.env.ASHBYHQ_DB_PATH!))
    Db.migrate(db)

    if(db.select({ count: D.count() }).from(Db.company).get()?.count === 0) {
        mainLog.I('Populating db')
        populate(db)
    }

    const companiesInProcess = new Set<string>()

    while(true) {
        mainLog.I('Tick')
        const nextTick = T.Now.instant().add({ seconds: 1 })

        const companiesInProcessList = [...companiesInProcess]
        let quota = 2

        const companiesToCheck = db.select().from(Db.company)
            .where(D.and(
                D.or(D.eq(Db.company.exists, 1), D.isNull(Db.company.exists)),
                D.not(D.inArray(Db.company.name, companiesInProcessList)),
            ))
            .orderBy(D.sql`${Db.company.checkedEpochMs} ASC NULLS FIRST`)
            .limit(quota)
            .all()
        quota -= companiesToCheck.length
        mainLog.I('Checking ', [companiesToCheck.length], ' companies')

        for(const company of companiesToCheck) {
            ;(async() => {
                const log = mainLog.addedCtx(company.name)

                companiesInProcess.add(company.name)
                try {
                    await checkCompany(db, log, company)
                }
                catch(err) {
                    log.E('While checking: ', [err])
                }
                finally {
                    companiesInProcess.delete(company.name)
                }
            })()
        }

        await U.delay(nextTick)
    }
}

async function checkCompany(
    db: BetterSQLite3Database,
    log: L.Log,
    company: D.InferSelectModel<typeof Db.company>,
) {
    const responseStatus = await fetchGraphql<ApiJobBoardWithTeams>(log, {
        operationName: 'ApiJobBoardWithTeams',
        'variables': {
            organizationHostedJobsPageName: company.name,
        },
        query: "query ApiJobBoardWithTeams($organizationHostedJobsPageName: String!) {\n  jobBoard: jobBoardWithTeams(\n    organizationHostedJobsPageName: $organizationHostedJobsPageName\n  ) {\n    teams {\n      id\n      name\n      externalName\n      parentTeamId\n      __typename\n    }\n    jobPostings {\n      id\n      title\n      teamId\n      locationId\n      locationName\n      workplaceType\n      employmentType\n      secondaryLocations {\n        ...JobPostingSecondaryLocationParts\n        __typename\n      }\n      compensationTierSummary\n      __typename\n    }\n    __typename\n  }\n}\n\nfragment JobPostingSecondaryLocationParts on JobPostingSecondaryLocation {\n  locationId\n  locationName\n  __typename\n}",
    })

    db.update(Db.company)
        .set({ checkedEpochMs: Date.now() })
        .where(D.eq(Db.company.name, company.name))
        .run()

    if(responseStatus.status !== 'ok') return

    const jobBoard = responseStatus.data.jobBoard
    if(jobBoard === null) {
        log.I('Company does not exist')

        db.update(Db.company)
            .set({ exists: 0 })
            .where(D.eq(Db.company.name, company.name))
            .run()
        return
    }

    const initial = company.exists === null

    const existingJobs = new Set(
        db.select()
            .from(Db.job)
            .where(D.eq(Db.job.companyName, company.name))
            .all()
            .map(it => it.id)
    )

    const toInsert: D.InferSelectModel<typeof Db.job>[] = []
    for(const job of jobBoard.jobPostings) {
        if(existingJobs.has(job.id)) continue
        toInsert.push({
            id: job.id,
            companyName: company.name,
            toFetch: initial ? 0 : 1,
            shortInfo: JSON.stringify({
                job,
                team: jobBoard.teams.find(it => it.id === job.teamId) ?? null,
            }),
            longInfo: null,
        })
    }

    db.transaction(db => {
        db.update(Db.company)
            .set({ exists: 1 })
            .where(D.eq(Db.company.name, company.name))
            .run()
        if(toInsert.length > 0) db.insert(Db.job).values(toInsert).run()
    })

    if(initial) {
        log.I('Found ', [toInsert.length], ' jobs')
    }
    else {
        log.I('Found ', [toInsert.length], ' new jobs')
    }
}

type ApiJobBoardWithTeams = {
    jobBoard: null | {
        teams: {
            id: string,
            name: string
            externalName: null
            parentTeamId: null
        }[]
        jobPostings: {
            id: string
            title: string
            teamId: string
            locationId: string
            locationName: string
            workplaceType: string
            employmentType: string
            secondaryLocations: string[] // TODO
            compensationTierSummary: null
        }[]
    }
}

async function fetchGraphql<T extends {}>(log: L.Log, body: any) {
    type GraphqlWrapper = {
        data?: T
        errors?: { message: string }[]
    }

    try {
        const response = await fetch('https://jobs.ashbyhq.com/api/non-user-graphql', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
            },
            body: JSON.stringify(body)
        })
        if(response.status === 429) {
            log.E('Rate limited')
            await response.text().catch(() => {})
            return U.status('error')
        }
        if(!response.ok) {
            log.E(
                'Request failed (soft): ',
                [response.status],
                ' with ',
                ...await response.text().then(
                    (it): L.Message => ['body ', [it]],
                    (err): L.Message => ['body error ', [err]],
                ),
            )
            return U.status('error')
        }

        const json: GraphqlWrapper = await response.json()
        if(json.data === undefined) {
            log.E('Query failed: ', [json])
            return U.status('error')
        }
        return U.result('ok', json.data)
    }
    catch(err) {
        log.E('Request failed: ', [err])
        return U.status('error')
    }
}

await main()
