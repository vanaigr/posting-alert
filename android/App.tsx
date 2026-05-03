import R from "react";
import {
    Platform,
    ScrollView,
    StyleSheet,
    Text,
    View,
    TouchableOpacity,
    ToastAndroid,
    Linking,
} from "react-native";
import { Ionicons } from '@expo/vector-icons';
import * as Notifications from "expo-notifications";
import * as FCM from "./fcm.config.ts";

export default function App() {
    return (
        <ScrollView contentContainerStyle={styles.container}>
            <TokenBox/>
            <View style={{ height: 20 }}/>
            <JobList/>
        </ScrollView>
    );
}

type Job = {
    id: string
    companyName: string
    jobTitle: string
    location: string
    url: string
    currentTime: number | undefined
}

type JobsResult = { status: 'pending' } | { status: 'error', data: unknown } | { status: 'ok', data: Job[] }

function JobList() {
    const [reload, setReload] = R.useState(0)
    const [jobsResult, setJobsResult] = R.useState<JobsResult>({ status: 'pending' })

    const [time, setTime] = R.useState(Date.now())

    R.useEffect(() => {
        const cancelId = setInterval(() => {
            setTime(Date.now())
        }, 60 * 1000)

        return () => {
            clearInterval(cancelId)
        }
    }, [])

    R.useEffect(() => {
        ;(async() => {
            const response = await fetch(
                new URL('jobs', FCM.SERVER_URL),
                { headers: { authorization: 'Bearer ' + FCM.BEARER } },
            )
            if(!response.ok) throw new Error(`${response.status}: ${response.text()}`)

            const result: any[] = await response.json()

            const jobs = result.map((it): Job => {
                const info = JSON.parse(it.shortInfo ?? '{}')?.job ?? {}
                return {
                    id: it.id,
                    companyName: it.companyName,
                    jobTitle: info?.title,
                    location: [
                        info?.locationName
                            + (info?.workplaceType ? ', ' + info.workplaceType : ''),
                        ...(info?.secondaryLocations ?? []).map((it: any) => {
                            return it.locationName
                        })
                    ].join('; '),
                    url: `https://jobs.ashbyhq.com/${encodeURIComponent(it.companyName)}/${encodeURIComponent(it.id)}`,
                    currentTime: it.fetchedEpochMs ?? undefined,
                }
            })
            jobs.sort((a, b) => {
                let diff: number

                if(a.currentTime === undefined || b.currentTime ===  undefined) {
                    diff = (a.currentTime === undefined ? 0 : 1) - (b.currentTime === undefined ? 0 : 1)
                    return diff
                }

                diff = a.currentTime - b.currentTime
                if(diff !== 0) return diff

                return 0
            })

            setJobsResult({ status: 'ok', data: jobs })
        })()
            .catch(err => {
                setJobsResult({ status: 'error', data: err })
                ToastAndroid.show('Error: ' + err, ToastAndroid.LONG)
            })
    }, [reload])

    const reloadView = <TouchableOpacity onPress={() => setReload(reload + 1)}>
        <Text>Reload</Text>
    </TouchableOpacity>

    if(jobsResult.status === 'pending') {
        return <View>
            {reloadView}
            <View style={{ display: 'flex', alignItems: 'center' }}>
                <Text>Loading...</Text>
            </View>
        </View>
    }
    if(jobsResult.status === 'error') {
        return <View>
            {reloadView}
            <View style={{ display: 'flex', alignItems: 'center' }}>
                <Text>Error</Text>
                <Text>{'' + jobsResult.data}</Text>
            </View>
        </View>
    }

    return <View>
        {reloadView}
        <View style={{ display: 'flex', gap: 10 }}>
            {jobsResult.data.map(job => {
                return <View
                    key={job.id}
                    style={[styles.box, { display: 'flex', flexDirection: 'row', gap: 8 }]}
                >
                    <TouchableOpacity
                        style={{ flex: 1 }}
                        onPress={() => {
                            Linking.openURL(job.url)
                        }}
                    >
                        <Text style={{ fontWeight: 'bold' }}>{job.jobTitle}</Text>
                        <View style={{ display: 'flex', flexDirection: 'row' }}>
                            <Text>{job.companyName}</Text>
                            <Text> | </Text>
                            <Text>{job.location}</Text>
                        </View>
                        <View style={{ display: 'flex', flexDirection: 'row' }}>
                            <Text>
                                {job.currentTime === undefined
                                    ? 'Unknown ago'
                                    : Math.min(999, Math.floor((time - job.currentTime) / (1000 * 60))) + ' min ago'
                                }
                            </Text>
                        </View>
                    </TouchableOpacity>
                    <View>
                        <TouchableOpacity
                            onPress={() => {
                                ;(async() => {
                                    const response = await fetch(
                                        new URL('jobs/' + encodeURIComponent(job.id), FCM.SERVER_URL),
                                        {
                                            method: 'DELETE',
                                            headers: { authorization: 'Bearer ' + FCM.BEARER },
                                        }
                                    )
                                    if(!response.ok) throw new Error(`${response.status}: ${response.text()}`)
                                    await response.json()

                                    setJobsResult(jobsResult => {
                                        if(jobsResult.status !== 'ok') return jobsResult
                                        return {
                                            ...jobsResult,
                                            data: jobsResult.data.filter(it => it !== job),
                                        }
                                    })
                                })()
                                    .catch(err => {
                                        ToastAndroid.show('Error: ' + err, ToastAndroid.LONG)
                                    })
                            }}
                        >
                            <Ionicons name='trash' size={17} color='#606060'/>
                        </TouchableOpacity>
                    </View>
                </View>
            })}
        </View>
    </View>
}

function TokenBox() {
    const [token, setToken] = R.useState<string | null>(null);
    const [error, setError] = R.useState<string | null>(null);

    R.useEffect(() => {
        (async () => {
            try {
                if (Platform.OS === "android") {
                    await Notifications.setNotificationChannelAsync(
                        FCM.ANDROID_NOTIFICATION_CHANNEL_ID,
                        {
                            name: "Default",
                            importance: Notifications.AndroidImportance.DEFAULT,
                        },
                    );
                }

                const existing = await Notifications.getPermissionsAsync();
                let status = existing.status;
                if (status !== "granted") {
                    const req = await Notifications.requestPermissionsAsync();
                    status = req.status;
                }
                if (status !== "granted") {
                    setError("Notification permission not granted");
                    return;
                }

                // Native FCM device token (NOT the Expo push token).
                const t = await Notifications.getDevicePushTokenAsync();
                setToken(typeof t.data === "string" ? t.data : JSON.stringify(t.data));
            } catch (e: any) {
                setError(e?.message ?? String(e));
            }
        })();
    }, []);

    return <View style={styles.box}>
        <Details title='FCM device token'>
            <Text>{error ? `ERROR: ${error}` : (token ?? "Loading…")}</Text>
        </Details>
    </View>

}

function Details({ title, children }: { title: string, children: R.ReactNode }) {
    const [expanded, setExpanded] = R.useState(false)

    return <>
        <TouchableOpacity
            onPress={() => {
                setExpanded(!expanded)
            }}
        >
            <View style={{ display: 'flex', flexDirection: 'row' }}>
                <Text>{title}</Text>
                <View style={{ flexGrow: 1 }}/>
                <Text>{expanded ? '+' : '-'}</Text>
            </View>
        </TouchableOpacity>
        {expanded && children}
    </>
}

const styles = StyleSheet.create({
    container: {
        flexGrow: 1,
        padding: 24,
        paddingTop: 64,
        backgroundColor: "#fff",
    },
    title: { fontSize: 20, fontWeight: "600", marginBottom: 8 },
    hint: { color: "#555", marginBottom: 16 },
    box: {
        padding: 12,
        backgroundColor: "#f3f3f3",
        borderRadius: 8,
    },
    token: { fontFamily: "monospace", fontSize: 13 },
});
