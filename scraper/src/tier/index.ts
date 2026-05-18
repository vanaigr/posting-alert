import { type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import * as L from '../lib/log.ts'
import * as U from '../lib/util.ts'
import * as C from '../lib/common.ts'

import cities from './cities.json' with { type: 'json' }
import states from './states.json' with { type: 'json' }
import cityCodes from './cityCodes.json' with { type: 'json' }
import stateCodes from './stateCodes.json' with { type: 'json' }

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

const cityStateRegexPart = `([a-zÀ-ÿ .'\\-]+,\\s+(${[...states, ...stateCodes].map(U.regexEscape).join('|')}))`

export const citiesStatesRegex3 = new RegExp(
    `^(${cityStateRegexPart}|.+,\\s+${cityStateRegexPart},\\s+\\d+)$`,
    'i'
)

const titleRegex = /(engineer|developer|programmer|\beng\b|member of technical staff|\bswe\b)/i
export function isJobRelevant(title: string) {
    return titleRegex.test(title)
        && !(
            /(site|sales|solutions?|electrical|mechanical|civil|geotechnical|mining|legal|manufacturing|network|nuclear|design|devops|security|infrastructure)( (reliability|field))? engineer/i.test(title)
                || /engineer in test/i.test(title)
                || /SDET/.test(title)
        )
}

export function isJobDesired(title: string, description: string | undefined) {
    const ignoreTitle = /\b(director|lead|manager|staff|supervisor|principal|president|qa|quality|quality assurance|machine learning|head of|servicenow|salesforce|forward deployed)\b/i.test(title)
        || /\b(UX)\b/.test(title)
    if(ignoreTitle) return false

    if(!isJobRelevant(title)) return false

    if(description) {
        const descriptionDesired = /(typescript|type script|reactjs|nodejs)/i.test(description)
            || /(Node|React)/.test(description)
        if(!descriptionDesired) return false
    }

    /*
    if(description) {
        const years = getYearsOfExperience(description)
        if(years > 5) return false
    }
    */

    return true
}

const getYears = /(?<!\bfor )\b(\d+)(\s*[-–—]\s*\d+)?\s*\+? (yrs|years|experience)/g
export function getYearsOfExperience(description: string) {
    return Math.max(
        ...[...description.matchAll(getYears)]
            .map(it => Number.parseInt(it[1], 10))
            // filter out false-positives from companies writing "we've been doing X 123 years"
            .filter(it => it <= 10),
    )
}


export function testMentionsUsConcrete(location: string) {
    return location
        .replaceAll(/\s*(;|\/|\|)\s*/g, ' | ')
        .split(' | ')
        .some(part => citiesStatesRegex3.test(part))
}

// Relevant location: in the US or remote worldwide
// Desired location: in Illinois or (not (onsite or hybrid) and in the US) or remote worldwide

type LocationExtras = Partial<{ remote: boolean, mentionsUs: boolean }>

export function isLocationRelevant(db: BetterSQLite3Database, location: string, extras: LocationExtras = {}) {
    const isMyLocal = location.includes('IL') || /(illinois|chicago)/i.test(location)
    if(isMyLocal) return true

    const isRemoteWorldwide = location.toLowerCase() === 'remote'
    if(isRemoteWorldwide) return true

    const mentionsUs = location.includes('US') || /(united states|u\. ?s\.|east coast|west coast)/i.test(location) || (extras.mentionsUs ?? false)
    if(mentionsUs) return true

    const mentionsUsConcrete = testMentionsUsConcrete(location)
    if(mentionsUsConcrete) return true

    const mayBeUs = citiesStatesRegex1.test(location) || citiesStatesRegex2.test(location)
    if(mayBeUs) {
        if(C.isLocationInUs(db, location)) return true
    }

    return false
}
export function isLocationDesired(db: BetterSQLite3Database, location: string, extras: LocationExtras = {}) {
    const isMyLocal = location.includes('IL') || /(illinois|chicago)/i.test(location)
    if(isMyLocal) return true

    const isRemoteWorldwide = location.toLowerCase() === 'remote'
    if(isRemoteWorldwide) return true

    //const isRemote = /(remote|nationwide|continental)/i.test(location) || (extras.remote ?? false)
    //if(isRemote) {
        const mentionsUs = location.includes('US') || /(united states|u\. ?s\.|east coast|west coast)/i.test(location) || (extras.mentionsUs ?? false)
        if(mentionsUs) return true

        const mentionsUsConcrete = testMentionsUsConcrete(location)
        if(mentionsUsConcrete) return true

        const mayBeUs = citiesStatesRegex1.test(location) || citiesStatesRegex2.test(location)
        if(mayBeUs) {
            if(C.isLocationInUs(db, location)) return true
        }
    //}

    return false
}
export async function isLocationDesiredFull(log: L.Log, db: BetterSQLite3Database, location: string, extras: LocationExtras = {}) {
    const isMyLocal = location.includes('IL') || /(illinois|chicago)/i.test(location)
    if(isMyLocal) return true

    const isRemoteWorldwide = location.toLowerCase() === 'remote'
    if(isRemoteWorldwide) return true

    //const isRemote = /(remote|nationwide|continental)/i.test(location) || (extras.remote ?? false)
    //if(isRemote) {
        const mentionsUs = location.includes('US') || /(united states|u\. ?s\.|east coast|west coast)/i.test(location) || (extras.mentionsUs ?? false)
        if(mentionsUs) return true

        const mentionsUsConcrete = testMentionsUsConcrete(location)
        if(mentionsUsConcrete) return true

        const mayBeUs = citiesStatesRegex1.test(location) || citiesStatesRegex2.test(location)
        if(mayBeUs) {
            if(await C.isLocationInUsFull(log, db, location)) return true
        }
    //}

    return false
}

export const bannedCompanies = [
    'jobgether',
    'g2i',
    'brightvisiontechnologies',
]
