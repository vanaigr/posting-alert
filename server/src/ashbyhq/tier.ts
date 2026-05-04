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

export const citiesStatesRegex = new RegExp(
    '\\b('
        + [...cities, ...states].map(U.regexEscape).join('|')
    + ')\\b',
    'i'
)
export const stateCodesRegex = new RegExp('\\b(' + stateCodes.map(U.regexEscape).join('|') + ')\\b')

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
        && !(
            /(site reliability engineer|sales engineer|solution engineer)/i.test(title)
        )
}
export function isTitleDesired(title: string) {
    return isTitleRelevant(title)
        && !/\b(director|lead|manager|staff|supervisor|principal|qa|quality assurance|machine learning|servicenow)\b/i.test(title)
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
