import fs from 'node:fs'
import path from 'node:path'
import util from 'node:util'
import 'dotenv/config'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import * as Db from './db.ts'

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

export function tier(db: BetterSQLite3Database) {
    const jobsByCompany = new Map<string, Job[]>()

    for(const job of db.select().from(Db.job).all()) {
        const infoRaw = JSON.parse(job.shortInfo ?? '{}')?.job
        if(!infoRaw) continue
        const info: Job = {
            title: infoRaw.title,
            locations: getJobLocation(infoRaw),
            workplaceType: infoRaw.workplaceType,
        }
        if(!isTitleRelevant(info) || !isLocationRelevant(info)) continue

        const jobs = (jobsByCompany.get(job.companyName) ?? [])
        jobs.push(info)
        jobsByCompany.set(job.companyName, jobs)
    }

    const desiredCompanies: string[] = []

    for(const [companyName, jobs] of jobsByCompany) {
        const desired = jobs.find(it => isRelevantLocationDesired(it))
        if(desired === undefined) continue
        desiredCompanies.push(companyName)
    }

    console.log(util.inspect(desiredCompanies, { maxArrayLength: Infinity }))
}

const titleRegex = /(engineer|developer|programmer)/i
function isTitleRelevant(job: Job) {
    return titleRegex.test(job.title)
}
function isLocationRelevant(job: Job) {
    return job.locations.some(name => {
        return isRemoteNationwide(name)
            || stateCodesRegex.test(name)
            || citiesStatesRegex.test(name)
    })
}
function isRemoteNationwide(location: string) {
    return location.includes('US')
        || /(united states|u\. ?s\.|nationwide)/i.test(location)
        || (/remote/i.test(location) && !otherCountriesRegex.test(location))
}

function isRelevantLocationDesired(job: Job) {
    return job.locations.some(location => {
        return location.includes('IL')
            || location.toLowerCase().includes('chicago')
            || isRemoteNationwide(location)
    })

}

function getJobLocation(job: any) {
    return [job.locationName, ...(job.secondaryLocations ?? []).map((it: any) => it.locationName)]
}

function regexEscape(str: string) {
    // @ts-ignore
    return RegExp.escape(str)
}

if(import.meta.main) {
    const db = drizzle(new Database(process.env.ASHBYHQ_DB_PATH!))
    Db.migrate(db)
    tier(db)
    console.log('done')
}
