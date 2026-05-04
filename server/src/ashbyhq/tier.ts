import fs from 'node:fs'
import path from 'node:path'
import util from 'node:util'
import 'dotenv/config'
import * as D from 'drizzle-orm'
import { type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import * as Db from '../lib/db.ts'
import * as U from '../lib/util.ts'

const { aCompany: Company, aJob: Job } = Db

const cities: string[] = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'sources', 'cities.json')).toString())
const states: string[] = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'sources', 'states.json')).toString())
const stateCodes: string[] = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'sources', 'stateCodes.json')).toString())
const otherCountries: string[] = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'sources', 'countries.json')).toString())

export const citiesStatesRegex = new RegExp(
    '('
        + [...cities, ...states].map(U.regexEscape).join('|')
    + ')',
    'i'
)
export const stateCodesRegex = new RegExp('(' + stateCodes.map(U.regexEscape).join('|') + ')')

export const otherCountriesRegex1 = new RegExp('(' + [...otherCountries, 'europe',  'south america', 'africa', 'asia'].map(U.regexEscape).join('|') + ')', 'i')
export const otherCountriesRegex2 = new RegExp('(MEA|LATAM|APAC|MENA)')

export type Tiers = {
    desiredCompanies: string[]
    relevantCompanies: string[]
}

export function calculateTiers(db: BetterSQLite3Database) {
    const relevantJobsByCompany = new Map<string, any[]>()

    for(const job of db.select().from(Job).all()) {
        const infoRaw = JSON.parse(job.shortInfo ?? '{}')?.job
        if(!infoRaw) continue
        if(!isLocationRelevant(infoRaw)) continue

        const jobs = (relevantJobsByCompany.get(job.companyName) ?? [])
        jobs.push(infoRaw)
        relevantJobsByCompany.set(job.companyName, jobs)
    }

    const desiredCompanies: string[] = []
    const relevantCompanies: string[] = []

    for(const [companyName, relevantJobs] of relevantJobsByCompany) {
        const desired = relevantJobs.find(it => isTitleRelevant(it.title))
        if(desired !== undefined) {
            desiredCompanies.push(companyName)
        }
        else {
            relevantCompanies.push(companyName)
        }
    }

    return {
        desiredCompanies,
        relevantCompanies,
    }
}

const titleRegex = /(engineer|developer|programmer)/i
export function isTitleRelevant(title: string) {
    return titleRegex.test(title)
}
export function isTitleDesired(title: string) {
    return isTitleRelevant(title)
        && !/\b(director|lead|manager|staff|qa|machine learning|servicenow)\b/i.test(title)
}

export function getJobLocations(job: any) {
    return [job.locationName, ...(job.secondaryLocations ?? []).map((it: any) => it.locationName)]
}
export function isLocationRelevant(job: any) {
    return getJobLocations(job).some(location => {
        const mentionsUs = location.includes('US') || /(united states|u\. ?s\.)/i.test(location)
        const mentionsUsConcrete = stateCodesRegex.test(location) || citiesStatesRegex.test(location)
        const isRemote = /(remote|nationwide)/i.test(location) || job.workplaceType === 'Remote'
        const isRemoteInUs = isRemote && (mentionsUs || mentionsUsConcrete)// || !(otherCountriesRegex1.test(location) || otherCountriesRegex2.test(location))))

        return mentionsUs || mentionsUsConcrete || isRemoteInUs
    })
}
/*
export function isLocationDesired(job: any) {
    return getJobLocations(job).some(location => {
        const mentionsUs = location.includes('US') || /(united states|u\. ?s\.)/i.test(location)
        const mentionsUsConcrete = stateCodesRegex.test(location) || citiesStatesRegex.test(location)
        const isRemote = /(remote|nationwide)/i.test(location) || job.workplaceType === 'Remote'
        const isRemoteInUs = isRemote && (mentionsUs || mentionsUsConcrete)// || !(otherCountriesRegex1.test(location) || otherCountriesRegex2.test(location))))
        const isMyLocal = location.includes('IL') || /(illinois|chicago)/i.test(location)

        return isRemoteInUs || isMyLocal
    })
}
*/




import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

const db = drizzle(new Database(process.env.DB_PATH!))
Db.migrate(db)

const results = calculateTiers(db)
console.log(results.desiredCompanies.length, results.relevantCompanies.length)
