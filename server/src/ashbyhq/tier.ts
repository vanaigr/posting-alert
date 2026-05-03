import fs from 'node:fs'
import path from 'node:path'
import util from 'node:util'
import 'dotenv/config'
import Database from 'better-sqlite3'
import * as D from 'drizzle-orm'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import * as Db from '../lib/db.ts'
import * as U from '../lib/util.ts'

const { aCompany: Company, aJob: Job } = Db

const cities: string[] = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'sources', 'cities.json')).toString())
const states: string[] = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'sources', 'states.json')).toString())
const stateCodes: string[] = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'sources', 'stateCodes.json')).toString())
const otherCountries: string[] = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'sources', 'countries.json')).toString())

const citiesStatesRegex = new RegExp(
    '('
        + [...cities, ...states].map(U.regexEscape).join('|')
    + ')',
    'i'
)
const stateCodesRegex = new RegExp('(' + stateCodes.map(U.regexEscape).join('|') + ')')

const otherCountriesRegex1 = new RegExp('(' + [...otherCountries, 'europe',  'south america', 'africa', 'asia'].map(U.regexEscape).join('|') + ')', 'i')
const otherCountriesRegex2 = new RegExp('(MEA|LATAM|APAC|MENA)')

export type Tiers = {
    desiredCompanies: string[]
    relevantCompanies: string[]
}

export function calculateTiers(db: BetterSQLite3Database) {
    const relevantJobsByCompany = new Map<string, any[]>()

    for(const job of db.select().from(Job).all()) {
        const infoRaw = JSON.parse(job.shortInfo ?? '{}')?.job
        if(!infoRaw) continue
        if(!isTitleRelevant(infoRaw.title) || !isLocationRelevant(infoRaw)) continue

        const jobs = (relevantJobsByCompany.get(job.companyName) ?? [])
        jobs.push(infoRaw)
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
            const desired = relevantJobs.find(it => isTitleDesired(it.title) && isLocationDesired(it))
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
export function isTitleRelevant(title: string) {
    return titleRegex.test(title)
}
export function isTitleDesired(title: string) {
    return isTitleRelevant(title)
        && !/\b(director|lead|manager|staff|qa)\b/i.test(title)
}

export function getJobLocations(job: any) {
    return [job.locationName, ...(job.secondaryLocations ?? []).map((it: any) => it.locationName)]
}
function isLocationRelevant(job: any) {
    return getJobLocations(job).some(location => {
        const mentionsUs = location.includes('US') || /(united states|u\. ?s\.)/i.test(location)
        const mentionsUsConcrete = stateCodesRegex.test(location) || citiesStatesRegex.test(location)
        const isRemote = /(remote|nationwide)/i.test(location) || job.workplaceType === 'Remote'
        const isRemoteInUs = (isRemote && (mentionsUs || mentionsUsConcrete || !(otherCountriesRegex1.test(location) || otherCountriesRegex2.test(location))))

        return mentionsUs || mentionsUsConcrete || isRemoteInUs
    })
}
function isLocationDesired(job: any) {
    return getJobLocations(job).some(location => {
        const mentionsUs = location.includes('US') || /(united states|u\. ?s\.)/i.test(location)
        const mentionsUsConcrete = stateCodesRegex.test(location) || citiesStatesRegex.test(location)
        const isRemote = /(remote|nationwide)/i.test(location) || job.workplaceType === 'Remote'
        const isRemoteInUs = (isRemote && (mentionsUs || mentionsUsConcrete || !(otherCountriesRegex1.test(location) || otherCountriesRegex2.test(location))))
        const isMyLocal = location.includes('IL') || /(illinois|chicago)/i.test(location)

        return isRemoteInUs || isMyLocal
    })
}

if(import.meta.main) {
    const db = drizzle(new Database(process.env.ASHBYHQ_DB_PATH!))
    Db.migrate(db)
    const tiers = calculateTiers(db)
    console.log(tiers.desiredCompanies.length, tiers.relevantCompanies.length)
    //console.log(util.inspect(tiers.desiredCompanies, { maxArrayLength: Infinity }))
    console.log('done')
}
