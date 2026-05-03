import * as D from 'drizzle-orm'
import { type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import * as U from '../lib/util.ts'
import * as L from '../lib/log.ts'
import * as T from '../lib/temporal.ts'
import * as Db from '../lib/db.ts'
import { populate } from './populate.ts'
import * as Tiers from './tier.ts'
import * as N from '../lib/network.ts'

const { aCompany: Company, aJob: Job } = Db

export async function run(db: BetterSQLite3Database, mainLog: L.Log) {
    populate(db)
    mainLog.I('Populated companies')

    const companiesInProcess = new Set<string>()
    let rateLimit = false

    let tiers: Tiers.Tiers = Tiers.calculateTiers(db)
    mainLog.I('Tiers: ', [tiers.desiredCompanies.length], ', ', [tiers.relevantCompanies.length])
    setInterval(() => {
        mainLog.I('Updating company tiers')
        tiers = Tiers.calculateTiers(db)
        mainLog.I('Tiers: ', [tiers.desiredCompanies.length], ', ', [tiers.relevantCompanies.length])
    }, 30 * 60 * 1000)

    const connection = N.createConnection('https://jobs.ashbyhq.com')

    while(true) {
        if(rateLimit) await U.delay(T.Now.instant().add({ seconds: 5 }))
        rateLimit = false

        mainLog.I('Tick')
        const nextTick = T.Now.instant().add({ seconds: 1, milliseconds: 100 })

        let desiredMax = 0
        let relevantMax = 0
        let otherMax = 0
        // TODO: this is biased if e.g. there's 100500 desired and 5 relevant.
        for(let i = 0; i < 5; i++) {
            const v = Math.random()

            otherMax++
            if(v < 0.25) continue
            relevantMax++
            if(v < 0.5) continue
            desiredMax++
        }

        const companiesInProcessList = [...companiesInProcess]

        let fetched = 0
        const desiredCompaniesToCheck = db.select().from(Company)
            .where(D.and(
                D.or(D.eq(Company.exists, 1), D.isNull(Company.exists)),
                D.inArray(Company.name, tiers.desiredCompanies),
                D.not(D.inArray(Company.name, companiesInProcessList)),
            ))
            .orderBy(D.sql`${Company.checkedEpochMs} ASC NULLS FIRST`)
            .limit(desiredMax - fetched)
            .all()
        fetched += desiredCompaniesToCheck.length
        const relevantCompaniesToCheck = db.select().from(Company)
            .where(D.and(
                D.or(D.eq(Company.exists, 1), D.isNull(Company.exists)),
                D.inArray(Company.name, tiers.relevantCompanies),
                D.not(D.inArray(Company.name, companiesInProcessList)),
            ))
            .orderBy(D.sql`${Company.checkedEpochMs} ASC NULLS FIRST`)
            .limit(relevantMax - fetched)
            .all()
        fetched += relevantCompaniesToCheck.length
        const otherCompaniesToCheck = db.select().from(Company)
            .where(D.and(
                D.or(D.eq(Company.exists, 1), D.isNull(Company.exists)),
                D.not(D.inArray(Company.name, tiers.desiredCompanies)),
                D.not(D.inArray(Company.name, tiers.relevantCompanies)),
                D.not(D.inArray(Company.name, companiesInProcessList)),
            ))
            .orderBy(D.sql`${Company.checkedEpochMs} ASC NULLS FIRST`)
            .limit(otherMax - fetched)
            .all()
        fetched += otherCompaniesToCheck.length

        mainLog.I(
            'Checking: ',
            [desiredCompaniesToCheck.length], ', ',
            [relevantCompaniesToCheck.length], ', ',
            [otherCompaniesToCheck.length], ', ',
        )

        ;(async() => {
            const companiesToCheck = [...desiredCompaniesToCheck, ...relevantCompaniesToCheck, ...otherCompaniesToCheck]

            try {
                const companyNames = companiesToCheck.map(it => it.name)
                for(const it of companiesToCheck) companiesInProcess.add(it.name)

                const result = await getCompaniesDetails(connection, mainLog, companyNames)
                if(result.status === 'rate-limit') {
                    rateLimit = true
                    return
                }

                const currentTime = Date.now()

                db.update(Company)
                    .set({ checkedEpochMs: currentTime })
                    .where(D.inArray(Company.name, companyNames))
                    .run()

                if(result.status !== 'ok') return

                for(let i = 0; i < companiesToCheck.length; i++) {
                    const company = companiesToCheck[i]
                    const log = mainLog.addedCtx(company.name)
                    checkCompany(db, log, currentTime, company, result.data[i])
                }
            }
            catch(err) {
                mainLog.E('While checking: ', [err])
            }
            finally {
                for(const it of companiesToCheck) companiesInProcess.delete(it.name)
            }
        })()

        await U.delay(nextTick)
    }
}

function checkCompany(
    db: BetterSQLite3Database,
    log: L.Log,
    currentTime: number,
    company: D.InferSelectModel<typeof Company>,
    jobBoard: ApiJobBoardWithTeams,
) {
    if(jobBoard === null) {
        log.I('Company does not exist')

        db.update(Company)
            .set({ exists: 0 })
            .where(D.eq(Company.name, company.name))
            .run()
        return
    }

    const initial = company.exists === null

    const existingJobs = new Set(
        db.select()
            .from(Job)
            .where(D.eq(Job.companyName, company.name))
            .all()
            .map(it => it.id)
    )

    const toInsert: D.InferSelectModel<typeof Job>[] = []
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
            fetchedEpochMs: currentTime,
        })

        if(!initial) {
            log.I('New job ', [job.id])
            if(
                /*
                Tiers.isTitleDesired(info)
                    && Tiers.isLocationRelevant(info)
                    && Tiers.isRelevantLocationDesired(info)
                */
                true
            ) {
                log.I('Job ', job.id, ' is relevant!')

                ;(async(log) => {
                    try {
                        const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
                            method: 'POST',
                            headers: { 'content-type': 'application/json' },
                            body: JSON.stringify({
                                chat_id: process.env.TELEGRAM_CHAT_ID,
                                text: job.title + ' @ ' + company.name + '\n'
                                    + Tiers.getJobLocations(job).join(' | ') + '\n'
                                    + `https://jobs.ashbyhq.com/${encodeURIComponent(company.name)}/${encodeURIComponent(job.id)}`,
                            })
                        })
                        if(!response.ok) throw new Error(`${response.status}: ${await response.text().catch(it => it)}`)
                        const body = await response.json()
                        if(!body.ok) {
                            throw new Error(`Telegram error: ${body.description}`)
                        }
                        log.I('Sent successfully')
                    }
                    catch(err) {
                        log.E('While sending notification: ', [err])
                    }
                })(log.addedCtx('job ', [job.id]))
            }
        }
    }

    db.transaction(db => {
        db.update(Company)
            .set({ exists: 1 })
            .where(D.eq(Company.name, company.name))
            .run()
        if(toInsert.length > 0) {
            db.insert(Job).values(toInsert).run()
        }
    })

    if(initial) {
        log.I('Found ', [toInsert.length], ' jobs')
    }
    else {
        log.I('Found ', [toInsert.length], ' new jobs')
    }
}

async function getCompaniesDetails(connection: N.Connection, log: L.Log, companies: string[]) {
    const companiesEncoded = companies.map((_, i) => encodeIndex(i))
    const header = 'query ApiJobBoardWithTeams('
        + companiesEncoded.map(it => '$' + it + ': String!').join(', ')
        + ') {\n'

        const footer = `
}

fragment JobPostingSecondaryLocationParts on JobPostingSecondaryLocation {
  locationId
  locationName
  __typename
}
`.trim()

    const boardParams = `
    teams {
      id
      name
      externalName
      parentTeamId
      __typename
    }
    jobPostings {
      id
      title
      teamId
      locationId
      locationName
      workplaceType
      employmentType
      secondaryLocations {
        ...JobPostingSecondaryLocationParts
        __typename
      }
      compensationTierSummary
      __typename
    }
    __typename
`.trim()

    const graphql = header
        + companiesEncoded.map(encoded => {
            return '  '
                + encoded
                + ': jobBoardWithTeams(organizationHostedJobsPageName: $'
                + encoded
                + ') {\n    ' + boardParams + '\n  }'
        }).join('\n')
        + '\n'
        + footer

    //console.log(graphql)
    //return U.status('error')

    const responseStatus = await fetchGraphql<Record<string, ApiJobBoardWithTeams>>(
        connection,
        log,
        {
            operationName: 'ApiJobBoardWithTeams',
            variables: Object.fromEntries(companiesEncoded.map((encoded, i) => [encoded, companies[i]])),
            query: graphql,
        }
    )
    if(responseStatus.status !== 'ok') return responseStatus

    return U.result(
        'ok',
        companiesEncoded.map(encoded => responseStatus.data[encoded]),
    )
}


function encodeIndex(n: number) {
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
    let result = ''
    do {
        result = alphabet[n % alphabet.length] + result
        n = Math.floor(n / alphabet.length)
    } while(n > 0)
    return result
}

type ApiJobBoardWithTeams = null | {
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

async function fetchGraphql<T extends {}>(connection: N.Connection, log: L.Log, body: any) {
    type GraphqlWrapper = {
        data?: T
        errors?: { message: string }[]
    }

    try {
        const response = await N.fetch(connection, {
            path: '/api/non-user-graphql',
            method: 'POST',
            headers: {
                'content-type': 'application/json',
            },
            body: JSON.stringify(body)
        })
        if(response.statusCode === 429) {
            log.E('Rate limited')
            await response.body.text().catch(() => {})
            return U.status('rate-limit')
        }
        if(response.statusCode !== 200) {
            log.E(
                'Request failed (soft): ',
                [response.statusCode],
                ' with ',
                ...await response.body.text().then(
                    (it): L.Message => ['body ', [it]],
                    (err): L.Message => ['body error ', [err]],
                ),
            )
            return U.status('error')
        }

        const json = await response.body.json() as GraphqlWrapper
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
