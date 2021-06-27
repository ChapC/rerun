import { youtube_v3, google } from 'googleapis';

let youtube : youtube_v3.Youtube = null;

export function getVideoMetadata(id: string) : Promise<youtube_v3.Schema$Video> {
    if (youtube == null) {
        youtube = google.youtube({
            version: 'v3', auth: 'AIzaSyDnOOiNzMSg6JuE7xnO9N2Bxq7dArn6k4M'
        });
    }

    return new Promise((resolve, reject) => {
        youtube.videos.list({
            id: id, part: 'contentDetails, snippet, id, liveStreamingDetails'
        }).then((response : any) => {
            if (response.status === 200) {
                //We good
                const responseData : youtube_v3.Schema$VideoListResponse = response.data;
                if (responseData.items.length === 0) {
                    reject('No videos with ID ' + id);
                    return;
                }
                
                resolve(responseData.items[0]);
            } else {
                reject('Failed to fetch metadata: GAPI responded with ' + response.status + ' - ' + response.statusText);
            }
        });
    });
}