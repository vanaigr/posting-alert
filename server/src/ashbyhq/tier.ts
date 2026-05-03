import fs from 'node:fs'
import path from 'node:path'
import util from 'node:util'
import 'dotenv/config'
import Database from 'better-sqlite3'
import * as D from 'drizzle-orm'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import * as Db from '../lib/db.ts'

const { aCompany: Company, aJob: Job } = Db

const cities: string[] = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'sources', 'cities.json')).toString())
const states: string[] = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'sources', 'states.json')).toString())
const stateCodes: string[] = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'sources', 'stateCodes.json')).toString())
const otherCountries: string[] = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'sources', 'countries.json')).toString())

const citiesStatesRegex = new RegExp(
    '('
        + [...cities, ...states].map(regexEscape).join('|')
    + ')',
    'i'
)
const stateCodesRegex = new RegExp('(' + stateCodes.map(regexEscape).join('|') + ')')
const otherCountriesRegex = new RegExp('(' + [...otherCountries, 'europe', 'latam', 'south america', 'africa', 'asia'].map(regexEscape).join('|') + ')', 'i')

type Job = {
    title: string
    locations: string[]
    workplaceType: string
}

export type Tiers = {
    desiredCompanies: string[]
    relevantCompanies: string[]
}

export function calculateTiers(db: BetterSQLite3Database) {
    const relevantJobsByCompany = new Map<string, Job[]>()

    for(const job of db.select().from(Job).all()) {
        const infoRaw = JSON.parse(job.shortInfo ?? '{}')?.job
        if(!infoRaw) continue
        const info: Job = {
            title: infoRaw.title,
            locations: getJobLocation(infoRaw),
            workplaceType: infoRaw.workplaceType,
        }
        if(!isTitleRelevant(info) || !isLocationRelevant(info)) continue

        const jobs = (relevantJobsByCompany.get(job.companyName) ?? [])
        jobs.push(info)
        relevantJobsByCompany.set(job.companyName, jobs)
    }

    const desiredCompanies: string[] = []
    const relevantCompanies: string[] = []
    //const irrelevantCompanies: string[] = []

    const allCompanies = db.select().from(Company).where(D.eq(Company.exists, 1)).all()

    for(const company of allCompanies) {
        const relevantJobs = relevantJobsByCompany.get(company.name)
        if(relevantJobs === undefined) {
            //irrelevantCompanies.push(company.name)
        }
        else {
            const desired = relevantJobs.find(it => isRelevantLocationDesired(it))
            if(desired !== undefined) {
                desiredCompanies.push(company.name)
            }
            else {
                relevantCompanies.push(company.name)
            }
        }
    }

    return {
        desiredCompanies,
        relevantCompanies,
        //irrelevantCompanies,
    }
}

const titleRegex = /(engineer|developer|programmer)/i
export function isTitleRelevant(job: Job) {
    return titleRegex.test(job.title)
}
export function isLocationRelevant(job: Job) {
    return job.locations.some(name => {
        return isRemoteNationwide(name)
            || stateCodesRegex.test(name)
            || citiesStatesRegex.test(name)
    })
}
function isRemoteNationwide(location: string) {
    const hasUs = location.includes('US') || /(united states|u\. ?s\.)/i.test(location)
    const hasConcreteLocation = stateCodesRegex.test(location) || citiesStatesRegex.test(location)

    return (hasUs && !hasConcreteLocation) || (/(remote|nationwide)/i.test(location) && !otherCountriesRegex.test(location))
}

export function isRelevantLocationDesired(job: Job) {
    return job.locations.some(location => {
        return location.includes('IL')
            || /(illinois|chicago)/i.test(location)
            || isRemoteNationwide(location)
    })
}
export function isTitleDesired(job: Job) {
    return titleRegex.test(job.title)
        && !/\b(director|lead|manager|staff|qa)\b/i.test(job.title)

}

export function getJobLocation(job: any) {
    return [job.locationName, ...(job.secondaryLocations ?? []).map((it: any) => it.locationName)]
}

function regexEscape(str: string) {
    // @ts-ignore
    return RegExp.escape(str)
}

if(import.meta.main) {
    const db = drizzle(new Database(process.env.ASHBYHQ_DB_PATH!))
    Db.migrate(db)
    const tiers = calculateTiers(db)
    console.log(tiers.desiredCompanies.length, tiers.relevantCompanies.length)
    //console.log(util.inspect(tiers.desiredCompanies, { maxArrayLength: Infinity }))
    console.log('done')
}
