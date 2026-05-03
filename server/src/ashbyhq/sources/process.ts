import fs from 'node:fs'
import path from 'node:path'

/*

curl -G 'https://web.archive.org/cdx/search/cdx' \
    --data-urlencode 'url=jobs.ashbyhq.com/*' \
    --data-urlencode 'output=json' \
    --data-urlencode 'fl=original' \
    --data-urlencode 'collapse=urlkey' \
    > archive-urls.json

gau --o gau-urls.txt jobs.ashbyhq.com

*/

const urls1: string[][] = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'archive-urls.json')).toString())
const urls2: string[] = fs.readFileSync(path.join(import.meta.dirname, 'gau-urls.txt')).toString().split('\n')

const httpPrefix = 'http://jobs.ashbyhq.com/'
const httpsPrefix = 'https://jobs.ashbyhq.com/'

const companies = new Set<string>()
function addUrl(url: string) {
    let prefixLen: number | undefined

    if(url.startsWith(httpsPrefix)) {
        prefixLen = httpsPrefix.length
    }
    else if(url.startsWith(httpPrefix)) {
        prefixLen = httpPrefix.length
    }

    if(prefixLen === undefined) {
        console.log('invalid url', url)
        return
    }

    const nextSlashI = Math.min(
        goodIndexOf(url, '/', prefixLen),
        goodIndexOf(url, '?', prefixLen),
        goodIndexOf(url, '#', prefixLen),
    )

    const companySlug = url.slice(prefixLen, nextSlashI)
    const name = decodeURIComponent(companySlug).toLowerCase()
    if(/^root\..+?_.+?_.+?_.+?_/.test(name)) return
    companies.add(name)
}

for(const [url, ...huh] of urls1) {
    if(huh.length > 0) console.log('huh')
    addUrl(url)
}
for(const url of urls2) {
    addUrl(url)
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
