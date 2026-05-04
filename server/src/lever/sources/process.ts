import fs from 'node:fs'
import path from 'node:path'

const urls1: string[] = fs.readFileSync(path.join(import.meta.dirname, 'archive-urls.txt')).toString().split('\n')
// gau returns empty
//const urls2: string[] = fs.readFileSync(path.join(import.meta.dirname, 'gau-urls.txt')).toString().split('\n')
// NOTE: turns out a lot of these are inactive now
const names3: string[] = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'thirdParty', 'lever_companies.json')).toString())

const prefixes = [
    'http://jobs.lever.co/',
    'https://jobs.lever.co/',
    'https://jobs.lever.co:443/',
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
for(const name of names3) {
    companies.add(name.toLowerCase())
}

console.log('Found', companies.size, 'companies')

fs.writeFileSync(
    path.join(import.meta.dirname, 'companyNames.json'),
    JSON.stringify([...companies]),
)

function goodIndexOf(str: string, search: string, position?: number) {
    const index = str.indexOf(search, position)
    if(index === -1) return str.length
    return index
}
