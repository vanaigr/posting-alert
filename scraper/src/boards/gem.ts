import * as D from 'drizzle-orm'
import { type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import * as U from '../lib/util.ts'
import * as L from '../lib/log.ts'
import * as T from '../lib/temporal.ts'
import * as Db from '../lib/db.ts'
import * as Tier from '../tier/index.ts'
import * as N from '../lib/network.ts'
import * as C from '../lib/common.ts'

const { gemCompany: Company, gemJob: Job } = Db

export async function run(db: BetterSQLite3Database, mainLog: L.Log, sampleSaver: C.SampleSaver) {
    const sampler = sampleSaver.createSampler('gem')
    await import('../sources/gem/companyNames.json', { with: { type: 'json' } }).then(it => {
        C.populateCompanies(mainLog, db, Company, it.default, { checkedEpochMs: null, exists: null, failCount: 0, tier: 0 })
    })
    C.initTierEvaluation(mainLog, db, Company, Job, calculateTier)

    const companiesInProcess = new Set<string>()
    let rateLimit = false

    const connection = N.createConnection('https://jobs.gem.com')

    while(true) {
        if(rateLimit) await U.delay(T.Now.instant().add({ seconds: 5 }))
        rateLimit = false
        while(companiesInProcess.size > 20) {
            mainLog.I('Stalling because ', [companiesInProcess.size], ' is pending')
            await U.delay(T.Now.instant().add({ seconds: 5 }))
        }

        mainLog.I('Tick (', [companiesInProcess.size], ' pending)')
        sampler.count++
        const nextTick = T.Now.instant().add({ seconds: 1 })

        const toCheck = C.getCompaniesToCheck(db, Company, [...companiesInProcess, ...Tier.bannedCompanies], {
            quota: 2, // too few companies
        })

        mainLog.I(
            'Checking: ',
            [toCheck.desired.length], ', ',
            [toCheck.relevant.length], ', ',
            [toCheck.other.length], ', ',
            [toCheck.missing.length], ', ',
        )

        const currentTime = Date.now()
        const handleCompanny = async(company: D.InferSelectModel<typeof Company>, tier: string) => {
            const log = mainLog.addedCtx(company.name)

            try {
                companiesInProcess.add(company.name)
                const result = await checkCompany(db, log, currentTime, connection, company, tier)
                if(result.status === 'rate-limit') rateLimit = true
            }
            catch(err) {
                log.E('While checking: ', [err])
            }
            finally {
                companiesInProcess.delete(company.name)
            }
        }

        for(const it of toCheck.missing) handleCompanny(it, '?')
        for(const it of toCheck.desired) handleCompanny(it, 'I')
        for(const it of toCheck.relevant) handleCompanny(it, 'II')
        for(const it of toCheck.other) handleCompanny(it, 'III')

        await U.delay(nextTick)
    }
}

async function checkCompany(
    db: BetterSQLite3Database,
    log: L.Log,
    currentTime: number,
    connection: N.Connection,
    company: D.InferSelectModel<typeof Company>,
    tier: string,
) {
    const result = await C.fetchGraphql<GraphqlResponse>(connection, log, '/api/public/graphql', {
        operationName: 'JobBoardList',
        variables: { boardId: company.name },
        query,
    })
    if(result.status === 'rate-limit') return result

    db.update(Company)
        .set({ checkedEpochMs: currentTime })
        .where(D.eq(Company.name, company.name))
        .run()

    if(result.status !== 'ok') {
        C.updateFailCount(log, db, Company, company)
        return U.status('ok')
    }

    if(!result.data.jobBoardExternal) {
        log.I('Company does not exist')

        db.update(Company)
            .set({ exists: 0, tier: 3 })
            .where(D.eq(Company.name, company.name))
            .run()
        return U.status('ok')
    }

    const initial = company.exists === null

    const existingJobsRows = db.select()
        .from(Job)
        .where(D.eq(Job.companyName, company.name))
        .all()
    const existingJobs = new Set(existingJobsRows.map(it => it.id))

    const toInsert: D.InferSelectModel<typeof Job>[] = []
    const promises: Promise<void>[] = []
    for(const rawJob of result.data.oatsExternalJobPostings.jobPostings) {
        const id = rawJob.extId
        if(existingJobs.has(id)) continue

        const jobInfo: JobInfo = {
            title: '' + rawJob.title,
            descriptionHtml: rawJob.descriptionHtml,
            locations: rawJob.locations,
        }

        const description = C.parseHtml(jobInfo.descriptionHtml)
        const jobDesired = Tier.isJobDesired(jobInfo.title, description)
        const locationDesired = isLocationDesired(jobInfo)

        toInsert.push({
            companyName: company.name,
            id: id,
            fetchedEpochMs: currentTime,
            info: JSON.stringify(jobInfo),
            relevancy: JSON.stringify({
                jr: Tier.isJobRelevant(jobInfo.title),
                lr: isLocationRelevant(jobInfo),
                jd: jobDesired,
                ld: locationDesired,
            }),
        })

        if(!initial) {
            log.I('New job ', [id])
            if(jobDesired && locationDesired) {
                log.I('Job ', id, ' is relevant!')

                const maxAgo = C.millisecToDurationString(Date.now() - (company.checkedEpochMs || 0))
                const locations = jobInfo.locations.map(it => {
                    const city = [...new Set([it.name, it.city])].filter(it => it).join(' - ')
                    return (it.isRemote ? 'Remote ' : '') + city + ', ' + it.isoCountry
                })

                promises.push(C.sendMessage(
                    log.addedCtx('job ', [id]),
                    db,
                    {
                        type: 'boardJob',
                        board: 'applytojob',
                        extra: {
                            companyName: company.name,
                            id: id,
                        },
                        message: jobInfo.title + ' @ ' + company.name + '\n'
                            + locations.join(' | ') + '\n'
                            + `Gem ${tier} < ${maxAgo} ago: https://jobs.gem.com/${encodeURIComponent(company.name)}/${id}`
                    + (Tier.isRequiringClearance(jobInfo.title, description) ? '⚠️ clearance?' : '')
                    },
                ))
            }
        }
    }

    await Promise.allSettled(promises)

    const newTier = toInsert.length > 0 || !company.exists
        ? C.evaluateCompanyTier(db, [...existingJobsRows, ...toInsert], calculateTier)
        : null

    db.transaction(db => {
        db.update(Company)
            .set({ exists: 1, failCount: 0, ...(newTier !== null ? { tier: newTier } : {}) })
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

    return U.status('ok')
}

const query = `
query JobBoardList($boardId: String!) {
  oatsExternalJobPostings(boardId: $boardId) {
    jobPostings {
      extId
      title
      descriptionHtml
      locations {
        name
        city
        isRemote
        isoCountry
      }
    }
  }
  jobBoardExternal(vanityUrlPath: $boardId) {
    id
  }
}
`.trim()

type GraphqlResponse = {
  oatsExternalJobPostings: {
    jobPostings: {
      extId: string
      title: string
      descriptionHtml: string
      locations: {
        name: string
        city: string
        isRemote: boolean
        isoCountry: string | null // 3 letter
      }[]
    }[]
  }
  jobBoardExternal: null | {
    id: string
  }
}

export type JobInfo = {
    title: string
    descriptionHtml: string
    locations: {
        name: string
        city: string
        isRemote: boolean
        isoCountry: string | null // 3 letter
    }[]
}

function calculateTier(_db: BetterSQLite3Database, job: D.InferSelectModel<typeof Job>) {
    const info: JobInfo = JSON.parse(job.info)
    if(isLocationRelevant(info)) {
        if(Tier.isJobRelevant(info.title)) return 1
        return 2
    }
    return 3
}

export function isLocationRelevant(info: JobInfo) {
    return info.locations.some(it => {
        const isInUs = it.isoCountry === 'USA'
        const isRemoteWorldwide = (it.isRemote || /(remote|global|international)/i.test(it.name)) && !it.isoCountry

        return isInUs || isRemoteWorldwide
    })
}

export function isLocationDesired(info: JobInfo) {
    return isLocationRelevant(info)
    /*
    return info.locations.some(it => {
        const isInUs = it.isoCountry === 'USA'
        const isRemote = it.isRemote || /(remote|nationwide|continental)/i.test(info.title)
        const isRemoteInUs = isRemote && isInUs
        const isRemoteWorldwide = (it.isRemote || /(remote|global|international)/i.test(it.name)) && !it.isoCountry
        const isMyLocal = /\bchicago\b/i.test(it.city) || /\bchicago\b/i.test(it.name)

        return isMyLocal || isRemoteInUs || isRemoteWorldwide
    })
    */
}
