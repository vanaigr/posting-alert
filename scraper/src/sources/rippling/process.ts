import fs from 'node:fs'
import path from 'node:path'

const urls1: string[] = fs.readFileSync(path.join(import.meta.dirname, 'archive-urls.txt')).toString().split('\n')

const prefixes = [
    'http://ats.rippling.com/',
    'https://ats.rippling.com/',
]

const companies = new Set<string>()
function addUrl(url: string) {
    const prefixLen = Math.max(...prefixes.map((it): number => {
        if(url.startsWith(it)) return it.length
        return -1
    }))
    if(prefixLen === -1) {
        console.log('invalid url', url)
        return
    }

    const nextSlashI = Math.min(
        goodIndexOf(url, '/', prefixLen),
        goodIndexOf(url, '?', prefixLen),
        goodIndexOf(url, '#', prefixLen),
    )

    const companySlug = url.slice(prefixLen, nextSlashI)
    const name = decodeURIComponent(companySlug)
    companies.add(name)
}

for(const url of urls1) {
    addUrl(url)
}

console.log('Found', companies.size, 'companies')

fs.writeFileSync(
    path.join(import.meta.dirname, 'companyNames.json'),
    JSON.stringify([...companies], undefined, 1),
)

function goodIndexOf(str: string, search: string, position?: number) {
    const index = str.indexOf(search, position)
    if(index === -1) return str.length
    return index
}
