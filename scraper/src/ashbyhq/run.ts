import * as D from 'drizzle-orm'
import { type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import * as U from '../lib/util.ts'
import * as L from '../lib/log.ts'
import * as T from '../lib/temporal.ts'
import * as Db from '../lib/db.ts'
import * as Tiers from './tier.ts'
import * as N from '../lib/network.ts'
import * as C from '../common.ts'

const { aCompany: Company, aJob: Job, aFetchJobDetails: FetchJobDetails } = Db

export async function run(db: BetterSQLite3Database, mainLog: L.Log) {
    await import('./sources/companyNames.json', { with: { type: 'json' } }).then(it => {
        C.populateCompanies(mainLog, db, Company, it.default, { checkedEpochMs: null, exists: null, tier: 0 })
    })
    C.evaluateTiers(mainLog, db, Company, Job, Tiers.calculateTier)

    const companiesInProcess = new Set<string>()
    const jobsInProcess = new Set<string>()
    let rateLimit = false

    const connection = N.createConnection('https://jobs.ashbyhq.com', { connections: 1 })

    while(true) {
        if(rateLimit) await U.delay(T.Now.instant().add({ seconds: 5 }))
        rateLimit = false
        while(companiesInProcess.size > 20) {
            mainLog.I('Stalling because ', [companiesInProcess.size], ' is pending')
            await U.delay(T.Now.instant().add({ seconds: 5 }))
        }

        mainLog.I('Tick (', [companiesInProcess.size], ' pending)')
        const nextTick = T.Now.instant().add({ seconds: 1 })


        const toCheck = C.getCompaniesToCheck(db, Company, [...companiesInProcess, ...C.bannedCompanies], { weights: [0.5, 0.1] })

        const jobsToCheckDetails = db.select()
            .from(FetchJobDetails)
            .innerJoin(Job, D.eq(FetchJobDetails.id, Job.id))
            .where(D.not(D.inArray(FetchJobDetails.id, [...jobsInProcess])))
            .orderBy(D.asc(FetchJobDetails.addedAt))
            .limit(5)
            .all()

        mainLog.I(
            'Checking: ',
            [toCheck.desired.length], ', ',
            [toCheck.relevant.length], ', ',
            [toCheck.other.length], ', ',
            [toCheck.missing.length], ', ',
            'job details: ', [jobsToCheckDetails.length],
        )

        ;(async() => {
            const companiesToCheck = [...toCheck.desired, ...toCheck.relevant, ...toCheck.other, ...toCheck.missing]
            const tiersByIndex: string[] = [
                ...toCheck.desired.map(() => 'I'),
                ...toCheck.relevant.map(() => 'II'),
                ...toCheck.other.map(() => 'III'),
                ...toCheck.missing.map(() => '?'),
            ]

            try {
                const companyNames = companiesToCheck.map(it => it.name)
                for(const it of companiesToCheck) companiesInProcess.add(it.name)
                for(const it of jobsToCheckDetails) jobsInProcess.add(it.ashbyhq_job.id)

                const jobDetailRequests: { id: string, companyName: string }[] = []
                for(const job of jobsToCheckDetails) {
                    if(job.ashbyhq_job.longInfo === null) {
                        jobDetailRequests.push({
                            companyName: job.ashbyhq_job.companyName,
                            id: job.ashbyhq_job.id,
                        })
                    }
                }

                const result = await getCompaniesDetails(connection, mainLog, companyNames, jobDetailRequests)
                if(result.status === 'rate-limit') {
                    rateLimit = true
                    return
                }

                const currentTime = Date.now()

                if(companyNames.length > 0) {
                    db.update(Company)
                        .set({ checkedEpochMs: currentTime })
                        .where(D.inArray(Company.name, companyNames))
                        .run()
                }

                if(result.status !== 'ok') return

                const promises: Promise<unknown>[] = []

                for(let i = 0; i < companiesToCheck.length; i++) {
                    const company = companiesToCheck[i]
                    const log = mainLog.addedCtx(company.name)
                    try {
                        checkCompany(
                            db, log, currentTime,
                            company, result.data.companies[i], tiersByIndex[i],
                        )
                    }
                    catch(err) {
                        log.E([err])
                    }
                }

                let detailI = 0
                for(let i = 0; i < jobsToCheckDetails.length; i++) {
                    const fetchRow = jobsToCheckDetails[i]
                    if(fetchRow.ashbyhq_job.longInfo === null) {
                        const detail = result.data.jobDetails[detailI]
                        detailI++
                        // I don't know how it conveys that the thing does not exist
                        // (may have been deleted before we could get it).
                        const longInfo = detail ? JSON.stringify(detail) : null

                        db.update(Job)
                            .set({ longInfo })
                            .where(D.eq(Job.id, fetchRow.ashbyhq_job.id))
                            .run()
                        fetchRow.ashbyhq_job.longInfo = longInfo
                    }

                    const log = mainLog.addedCtx([fetchRow.ashbyhq_job.companyName], ' job ', [fetchRow.ashbyhq_job.id])
                    promises.push(processJobDetail(db, log, fetchRow))
                }

                await Promise.allSettled(promises)
            }
            catch(err) {
                mainLog.E('While checking: ', [err])
            }
            finally {
                for(const it of companiesToCheck) companiesInProcess.delete(it.name)
                for(const it of jobsToCheckDetails) jobsInProcess.delete(it.ashbyhq_job.id)
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
    tier: string,
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

    const existingJobsRows = db.select()
        .from(Job)
        .where(D.eq(Job.companyName, company.name))
        .all()
    const existingJobs = new Set(existingJobsRows.map(it => it.id))

    const toInsert: D.InferSelectModel<typeof Job>[] = []
    const toEnqueueDetails: D.InferSelectModel<typeof FetchJobDetails>[] = []
    for(const job of jobBoard.jobPostings) {
        if(existingJobs.has(job.id)) continue

        toInsert.push({
            id: job.id,
            companyName: company.name,
            shortInfo: JSON.stringify({
                job,
                team: jobBoard.teams.find(it => it.id === job.teamId) ?? null,
            }),
            longInfo: null,
            fetchedEpochMs: currentTime,
        })

        if(!initial) {
            log.I('New job ', [job.id])
            if(Tiers.isJobDesired(job.title, undefined) && Tiers.isLocationDesired(job)) {
                log.I('Job ', job.id, ' is initially relevant, queuing for detail fetch')
                toEnqueueDetails.push({
                    id: job.id,
                    addedAt: currentTime,
                    jobPostedAfter: company.checkedEpochMs ?? 0,
                    companyTier: tier,
                })
            }
        }
    }

    const newTier = toInsert.length > 0
        ? Tiers.calculateTier(company, [...existingJobsRows, ...toInsert])
        : null

    db.transaction(db => {
        db.update(Company)
            .set({ exists: 1, ...(newTier !== null ? { tier: newTier } : {}) })
            .where(D.eq(Company.name, company.name))
            .run()
        if(toInsert.length > 0) {
            db.insert(Job).values(toInsert).run()
        }
        if(toEnqueueDetails.length > 0) {
            db.insert(FetchJobDetails).values(toEnqueueDetails).run()
        }
    })

    if(initial) {
        log.I('Found ', [toInsert.length], ' jobs')
    }
    else {
        log.I('Found ', [toInsert.length], ' new jobs')
    }
}

async function processJobDetail(
    db: BetterSQLite3Database,
    log: L.Log,
    fetchRow: { ashbyhq_job: D.InferSelectModel<typeof Job>, ashby_fetch_job_details: D.InferSelectModel<typeof FetchJobDetails> },
) {
    const shortInfo = JSON.parse(fetchRow.ashbyhq_job.shortInfo)
    const job = shortInfo.job

    let shouldSend = false
    if(!fetchRow.ashbyhq_job.longInfo) {
        log.W('Could not get job info. Considering relevant')
        shouldSend = true
    }
    else {
        const detail = JSON.parse(fetchRow.ashbyhq_job.longInfo)
        if(Tiers.isJobDesired(job.title, detail.descriptionHtml ?? undefined) && Tiers.isLocationDesired(job)) {
            log.I('Job is still relevant after detail check')
            shouldSend = true
        }
        else {
            log.I('Job is not relevant after detail check')
        }
    }

    if(shouldSend) {
        const tier = fetchRow.ashby_fetch_job_details.companyTier

        const ago = C.millisecToDurationString(Date.now() - fetchRow.ashby_fetch_job_details.jobPostedAfter)

        await C.sendMessage(
            log,
            db,
            job.title + ' @ ' + fetchRow.ashbyhq_job.companyName + '\n'
                + job.workplaceType + ': ' + Tiers.getJobLocations(job).join(' | ') + '\n'
                + `Ashby ${tier} < ${ago} ago: ` + `https://jobs.ashbyhq.com/${encodeURIComponent(fetchRow.ashbyhq_job.companyName)}/${encodeURIComponent(fetchRow.ashbyhq_job.id)}`
        )
    }

    db.delete(FetchJobDetails).where(D.eq(FetchJobDetails.id, fetchRow.ashby_fetch_job_details.id)).run()
}

async function getCompaniesDetails(
    connection: N.Connection,
    log: L.Log,
    companies: string[],
    jobDetails: { companyName: string, id: string }[],
) {
    if(companies.length === 0 && jobDetails.length === 0) {
        return U.result('ok', { companies: [], jobDetails: [] })
    }

    const companyEncoded = companies.map((_, i) => encodeIndex(i))
    const jobDetailEncoded = jobDetails.map((_, i) => encodeIndex(i))

    const variableDefs: string[] = []
    for(const e of companyEncoded) variableDefs.push('$c' + e + ': String!')
    for(const e of jobDetailEncoded) {
        variableDefs.push('$jc' + e + ': String!')
        variableDefs.push('$ji' + e + ': String!')
    }

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

    const jobPostingParams = `
    id
    title
    departmentName
    locationName
    workplaceType
    employmentType
    descriptionHtml
    teamNames
    publishedDate
    compensationTierSummary
`.trim()

    const companySelections = companyEncoded.map(encoded => {
        return '  '
            + 'c' + encoded
            + ': jobBoardWithTeams(organizationHostedJobsPageName: $c'
            + encoded
            + ') {\n    ' + boardParams + '\n  }'
    })
    const jobSelections = jobDetailEncoded.map(encoded => {
        return '  '
            + 'j' + encoded
            + ': jobPosting(organizationHostedJobsPageName: $jc'
            + encoded
            + ', jobPostingId: $ji'
            + encoded
            + ') {\n    ' + jobPostingParams + '\n  }'
    })

    const fragments: string[] = []
    if(companies.length > 0) {
        fragments.push(`fragment JobPostingSecondaryLocationParts on JobPostingSecondaryLocation {
  locationId
  locationName
  __typename
}`)
    }

    const graphql = 'query ApiJobBoardWithTeams('
        + variableDefs.join(', ')
        + ') {\n'
        + [...companySelections, ...jobSelections].join('\n')
        + '\n}'
        + (fragments.length > 0 ? '\n\n' + fragments.join('\n\n') : '')

    const variables: Record<string, string> = {}
    for(let i = 0; i < companies.length; i++) {
        variables['c' + companyEncoded[i]] = companies[i]
    }
    for(let i = 0; i < jobDetails.length; i++) {
        variables['jc' + jobDetailEncoded[i]] = jobDetails[i].companyName
        variables['ji' + jobDetailEncoded[i]] = jobDetails[i].id
    }

    const responseStatus = await fetchGraphql<Record<string, ApiJobBoardWithTeams | ApiJobPosting>>(
        connection,
        log,
        {
            operationName: 'ApiJobBoardWithTeams',
            variables,
            query: graphql,
        }
    )
    if(responseStatus.status !== 'ok') return responseStatus

    return U.result(
        'ok',
        {
            companies: companyEncoded.map(e => responseStatus.data['c' + e] as ApiJobBoardWithTeams),
            jobDetails: jobDetailEncoded.map(e => responseStatus.data['j' + e] as ApiJobPosting),
        },
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

type ApiJobPosting = null | {
    id: string
    title: string
    departmentName: string | null
    locationName: string | null
    workplaceType: string | null
    employmentType: string | null
    descriptionHtml: string | null
    teamNames: string[] | null
    publishedDate: string | null
    compensationTierSummary: string | null
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
