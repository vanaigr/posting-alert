import { type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import * as L from '../lib/log.ts'
import * as U from '../lib/util.ts'
import * as C from '../lib/common.ts'

import cities from './cities.json' with { type: 'json' }
import states from './states.json' with { type: 'json' }
import cityCodes from './cityCodes.json' with { type: 'json' }
import stateCodes from './stateCodes.json' with { type: 'json' }

const wordBound = '\\b'
const digit = '\\d'
const space = '\\s'

export function isJobRelevant(title: string) {
    return titleRegex.test(title) && !ignoreTitleRegex.test(title)
}
export function isJobDesired(title: string, description: string | undefined) {
    if(!isJobRelevant(title)) return false
    if(nonDesiredTitleRegex.test(title)) return false

    if(description) {
        const descriptionDesired = /(typescript|type script|reactjs|nodejs)/i.test(description)
            || /(Node|React)/.test(description)
        if(!descriptionDesired) return false
    }

    const years = getYearsOfExperience([title, description].filter(it => it !== undefined))
    if(years >= 4) return false

    return true
}
export function getYearsOfExperience(parts: readonly string[]) {
    return Math.max(
        ...parts.flatMap(it => [...it.matchAll(getYears)])
            .map(it => Number.parseInt(it[1], 10))
            // filter out false-positives from companies writing "we've been doing X 123 years"
            .filter(it => it <= 10),
    )
}

const titleRegex = /(engineer|developer|programmer|\beng\b|member of technical staff|\bswe\b)/i
const ignoreTitleRegex = new RegExp(
    or([
        concat([
            wordBound,
            or([
                'civil', 'design', 'devops', 'electrical',
                'geotechnical', 'infrastructure', 'legal', 'manufacturing',
                'mechanical', 'mining', 'network', 'nuclear',
                'sales', 'security', 'site', 'solutions?',
                'data',
            ]),
            optional(concat([
                ' ',
                or(['reliability', 'field']),
            ])),
            ' engineer',
        ]),
        concat([
            wordBound,
            or(['devrel', 'developer relations', 'engineer in test', 'sdet']),
            wordBound,
        ]),
    ]),
    'i',
)
const nonDesiredTitleRegex = new RegExp(
    concat([
        wordBound,
        or([
            'director', 'head of', 'lead', 'president',
            'principal', 'staff', 'supervisor', 'vp of',
            'ai(/ml)? engineer', 'drupal', 'forward deployed', 'java',
            'machine learning', 'manager', 'power bi', 'python', 'qa',
            'quality', 'salesforce', 'servicenow',
            'sharepoint', 'shopify', 'ux',
        ]),
        wordBound,
    ]),
    'i',
)
const getYears = new RegExp(
    concat([
        `(?<!${wordBound}for )`,
        wordBound,
        '(', concat([digit, '+']), ')', // group 1
        optional(concat([
            space, '*',
            '[-–—]',
            space, '*',
            digit, '+',
        ])),
        optional(or(['\\+', 'plus'])),
        space, '+',
        or(['yrs', 'years', 'experience']),
    ]),
    'gi',
)


// Relevant location: in the US or remote worldwide
// Desired location: in Illinois or (not (onsite or hybrid) and in the US) or remote worldwide

type LocationExtras = Partial<{ remote: boolean, mentionsUs: boolean }>

export function isLocationRelevant(db: BetterSQLite3Database, location: string, extras: LocationExtras = {}) {
    if(testMyLocal(location)) return true
    if(locationRemoteWorldwideRegex.test(location)) return true

    const mentionsUs = (extras.mentionsUs ?? false) || location.includes('US') || mentionsUsRegex.test(location)
    if(mentionsUs) return true

    if(testMentionsUsConcrete(location)) return true

    const mayBeUs = citiesStatesRegex1.test(location) || citiesStatesRegex2.test(location)
    if(mayBeUs) {
        if(C.isLocationInUs(db, location)) return true
    }

    return false
}
export function isLocationDesired(db: BetterSQLite3Database, location: string, extras: LocationExtras = {}) {
    if(testMyLocal(location)) return true
    if(locationRemoteWorldwideRegex.test(location)) return true

    const isRemote = (extras.remote ?? false) || locationRemoteRegex.test(location)
    if(isRemote) {
        const mentionsUs = (extras.mentionsUs ?? false) || location.includes('US') || mentionsUsRegex.test(location)
        if(mentionsUs) return true

        if(testMentionsUsConcrete(location)) return true

        const mayBeUs = citiesStatesRegex1.test(location) || citiesStatesRegex2.test(location)
        if(mayBeUs) {
            if(C.isLocationInUs(db, location)) return true
        }
    }

    return false
}
export async function isLocationDesiredFull(log: L.Log, db: BetterSQLite3Database, location: string, extras: LocationExtras = {}) {
    if(testMyLocal(location)) return true
    if(locationRemoteWorldwideRegex.test(location)) return true

    const isRemote = (extras.remote ?? false) || locationRemoteRegex.test(location)
    if(isRemote) {
        const mentionsUs = (extras.mentionsUs ?? false) || location.includes('US') || mentionsUsRegex.test(location)
        if(mentionsUs) return true

        if(testMentionsUsConcrete(location)) return true

        const mayBeUs = citiesStatesRegex1.test(location) || citiesStatesRegex2.test(location)
        if(mayBeUs) {
            if(await C.isLocationInUsFull(log, db, location)) return true
        }
    }

    return false
}
export function testMyLocal(location: string) {
    return myCityStateRegex.test(location) || myCityStateRegex2.test(location)
}

function testMentionsUsConcrete(location: string) {
    return location.split(locationSeparatorRegex).some(part => citiesStatesRegex3.test(part.trim()))
}

export const citiesStatesRegex1 = new RegExp(
    concat([
        '\\b',
        or([...cities, ...states].map(U.regexEscape)),
        '\\b',
    ]),
    'i',
)
export const citiesStatesRegex2 = new RegExp(
    concat([
        '\\b',
        or([...stateCodes, ...cityCodes].map(U.regexEscape)),
        '\\b',
    ])
)
const cityStateRegexPart = `([a-zÀ-ÿ .'\\-]+,\\s+(${[...states, ...stateCodes].map(U.regexEscape).join('|')}))`
// NOTE: occasionaly matches unrelated places e.g. "Berlin, DE" (because DE is a state code).
export const citiesStatesRegex3 = new RegExp(
    `^(${cityStateRegexPart}|.+,\\s+${cityStateRegexPart},\\s+\\d+)$`,
    'i'
)
const myCityStateRegex = /\bIL\b/
const myCityStateRegex2 = /\b(illinois|chicago)\b/i
const locationSeparatorRegex = new RegExp(or(['|', ';', '/'].map(it => U.regexEscape(it))), 'g')
const locationRemoteWorldwideRegex = /^remote$/i
const mentionsUsRegex = /(united states|u\. ?s\.|east coast|west coast)/i
const locationRemoteRegex = /(remote|nationwide|continental)/i


export function isRequiringClearance(title: string, description: string | undefined) {
    const text = [title, description].filter(it => it !== undefined && it).join('\n')

    return /(\bTS\/SCI\b|\b(us|u\. ?s\.) citizen|\bclearance\b|\bexport (control|regulation))/i.test(text)
}
export function getJobWarnings(title: string, description: string | undefined) {
    const warnings: string[] = []

    const yoe = getYearsOfExperience([title, description].filter(it => it !== undefined))
    const yoeText = isFinite(yoe) ? '' + yoe : '?'
    warnings.push(yoeText + ' YoE')

    if(isRequiringClearance(title, description)) {
        warnings.push('⚠️ clearance?')
    }

    if(!description) {
        warnings.push('⚠️ no desc')
    }

    return warnings.join(' | ') + '\n'
}


function or(parts: readonly string[]) {
    return '(?:' + parts.map(it => '(?:' + it + ')').join('|') + ')'
}
function concat(parts: readonly string[]) {
    return parts.join('')
}
function optional(inner: string) {
    return '(?:' + inner + ')?'
}
