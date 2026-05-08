import fs from 'node:fs'
import path from 'node:path'
import util from 'node:util'
import 'dotenv/config'
import * as D from 'drizzle-orm'

import * as Db from '../lib/db.ts'
import * as U from '../lib/util.ts'

const { aCompany: Company, aJob: Job } = Db

const cities: string[] = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'sources', 'cities.json')).toString())
const states: string[] = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'sources', 'states.json')).toString())
const stateCodes: string[] = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'sources', 'stateCodes.json')).toString())
const cityCodes: string[] = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'sources', 'cityCodes.json')).toString())

export const citiesStatesRegex1 = new RegExp(
    '\\b('
        + [...cities, ...states].map(U.regexEscape).join('|')
    + ')\\b',
    'i'
)
export const citiesStatesRegex2 = new RegExp(
    '\\b('
        + [
            ...stateCodes,
            ...cityCodes,
        ].map(U.regexEscape).join('|')
        + ')\\b',
)

export function calculateTier(
    _company: D.InferSelectModel<typeof Company>,
    jobs: D.InferSelectModel<typeof Job>[],
): number {
    let hasRelevantLocation = false
    for(const job of jobs) {
        const infoRaw = JSON.parse(job.shortInfo ?? '{}')?.job
        if(!infoRaw) continue
        if(!isLocationRelevant(infoRaw)) continue
        hasRelevantLocation = true
        if(isJobRelevant(infoRaw.title)) return 1
    }
    return hasRelevantLocation ? 2 : 3
}

// NOTE: if this is changed, add a migration that resets tiers for the companies.
const titleRegex = /(engineer|developer|programmer)/i
export function isJobRelevant(title: string) {
    return titleRegex.test(title)
        && !(
            /(site|sales|solutions?|electrical|mechanical|civil|geotechnical|mining|legal|manufacturing|network|nuclear)( (reliability|field))? engineer/i.test(title)
        )
}

export function isJobDesired(title: string, description: string | undefined) {
    const ignoreTitle = /\b(director|lead|manager|staff|supervisor|principal|president|qa|quality assurance|machine learning|servicenow)\b/i.test(title)
        || /\b(UX)\b/.test(title)
    if(ignoreTitle) return false

    if(!isJobRelevant(title)) return false

    if(description) {
        const descriptionDesired = /(typescript|type script|reactjs|nodejs)/i.test(description)
            || /(Node|React)/.test(description)
        if(!descriptionDesired) return false
    }

    return true
}

export function getJobLocations(job: any) {
    return [job.locationName, ...(job.secondaryLocations ?? []).map((it: any) => it.locationName)]
}
// Unfortunately ashbyhq does not give a way to get job description in 1 request with job list (and I don't want to half our throughput),
// so we don't have the JD, and have to be more lenient.
// NOTE: if this is changed, add a migration that resets tiers for the companies.
export function isLocationRelevant(job: any) {
    return getJobLocations(job).some(location => {
        const mentionsUs = location.includes('US') || /(united states|u\. ?s\.|east coast|west coast)/i.test(location)
        const mentionsUsConcrete = citiesStatesRegex1.test(location) || citiesStatesRegex2.test(location)
        const isRemote = /(remote|nationwide|continental)/i.test(location) || job.workplaceType === 'Remote'
        const isRemoteInUs = isRemote && (mentionsUs || mentionsUsConcrete)// || !(otherCountriesRegex1.test(location) || otherCountriesRegex2.test(location))))
        const isRemoteWorldwide = location.toLowerCase() === 'remote'

        return mentionsUs || mentionsUsConcrete || isRemoteInUs || isRemoteWorldwide
    })
}
export function isLocationDesired(job: any) {
    return getJobLocations(job).some(location => {
        const mentionsUs = location.includes('US') || /(united states|u\. ?s\.|east coast|west coast)/i.test(location)
        const mentionsUsConcrete = citiesStatesRegex1.test(location) || citiesStatesRegex2.test(location)
        const isRemote = /(remote|nationwide|continental)/i.test(location) || job.workplaceType === 'Remote'
        const isRemoteInUs = isRemote && (mentionsUs || mentionsUsConcrete)// || !(otherCountriesRegex1.test(location) || otherCountriesRegex2.test(location))))
        const isRemoteWorldwide = location.toLowerCase() === 'remote'
        const isMyLocal = location.includes('IL') || /(illinois|chicago)/i.test(location)
        const onSite = !isRemote && (job.workplaceType === 'OnSite' || job.workplaceType === 'Hybrid')

        return isRemoteInUs || isRemoteWorldwide || isMyLocal || ((mentionsUs || mentionsUsConcrete) && !(mentionsUsConcrete && onSite))
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
