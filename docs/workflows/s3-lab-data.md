# Workflow: lab data on S3 (AWS, Cloudflare R2, Backblaze B2, MinIO)

[← Docs index](../index.md) · [← User guide](../guide.md)

Keep the lab's BAMs in one object-storage bucket, and let everyone open them
in FiberBrowser (the Mac app or `pip install fiberbrowser`) without copying
whole files around. FiberBrowser reads only the byte ranges it needs: the
index once, then the part of the BAM under the region you look at.

What opens from `s3://`:

| File | From S3 | Notes |
|------|---------|-------|
| BAM | yes | With its index beside it (`x.bam.bai`, `x.bai`, `x.bam.csi` or `x.csi`), or named: `s3://b/x.bam##idx##s3://b/idx/x.bai`. |
| BigBed reads (`.bb`) | yes | As datasets, like BAMs. |
| bigWig / bigBed tracks | yes | **Tracks** panel, or a catalog's `tracks`. |
| `.cool` / `.mcool` contact maps | yes | Read by range; nothing extra to install. |
| FASTA | no | Download it (and its `.fai`) and open the local copy. |
| Footprint-class runs | no | FiberHMM reads the BAM from this computer: download the BAM, or just the region (see [Speed, cost and caching](#speed-cost-and-caching)). |

Everything else (reads, layers, clustering, peaks, figures, exports) works on
remote data as on local files.

## 1. Choose a provider

All of these speak the S3 protocol; FiberBrowser treats them the same. Prices
below are **rough figures for orientation only (2026); check each provider's
pricing page before you decide**, and ask about academic discounts.

| Provider | Storage (approx.) | Download / egress (approx.) | Good for |
|----------|-------------------|-----------------------------|----------|
| **AWS S3** (Standard) | ~$23 per TB-month | ~$90 per TB downloaded to the internet (the first 100 GB a month free); ~$0.40 per million reads | Labs already on AWS, data next to AWS compute. Watch egress if people download whole BAMs. |
| **Cloudflare R2** | ~$15 per TB-month | No egress fees; ~$0.36 per million reads | Many readers, or a public data release: downloads cost nothing. |
| **Backblaze B2** | ~$6 per TB-month | Free up to about 3× what you store each month, then ~$10 per TB | The cheapest large archive. |
| **Institutional** (your university's Ceph/MinIO/S3 gateway) | Often free or a flat recharge per TB | Usually free on campus | Ask research computing; often the simplest. |

What it costs to *browse*: very little. Opening a dataset reads its header and
index (kilobytes to a few MB) and samples a few dozen small windows. Each new
region you open reads a few MB: htslib asks for "from here onwards" and stops
when it has enough, so a little more than the region's reads is sent. On the
test setup below, a whole browsing session on a 120 MB BAM moved about 250 MB.
What costs money on AWS is people downloading entire BAMs again and again.

Example, 2 TB of BAMs and indexes: roughly $45 a month on AWS S3, $30 on R2,
$12 on B2, before downloads.

## 2. Lay out the bucket

One bucket for the lab, one folder (prefix) per project or run, each BAM with
its index under the same name:

```text
s3://smithlab-fiber/
  projects/embryo-timecourse/2026-09/dl_2-4h.bam
  projects/embryo-timecourse/2026-09/dl_2-4h.bam.bai
  projects/embryo-timecourse/2026-09/dl_2-4h.nucleosome.bb
  projects/embryo-timecourse/2026-09/contacts/dl_2-4h.mcool
  public/paper-2026/...            # what you will publish, if anything
```

- Index before you upload (`samtools index x.bam`; `samtools index -c` for
  `.csi` on chromosomes over 512 Mb).
- Avoid spaces and `#` in names (they work, but they make copying URLs
  error-prone).
- If you replace a BAM, upload its new index too. FiberBrowser notices a
  replaced file (its ETag changes) within about 30 seconds and reopens it
  with the new index; an old index with a new BAM gives wrong reads in any
  tool. A replaced contact map asks to be loaded again.
- Keep a separate prefix (or bucket) for anything you will make public.

## 3. Upload

With the AWS command line (`pip install awscli`, or Homebrew `awscli`), using
an **admin** profile that may write (see step 5 for read-only keys):

```bash
aws s3 cp dl_2-4h.bam     s3://smithlab-fiber/projects/embryo-timecourse/2026-09/ --profile lab-admin
aws s3 cp dl_2-4h.bam.bai s3://smithlab-fiber/projects/embryo-timecourse/2026-09/ --profile lab-admin
# or a whole folder:
aws s3 sync ./2026-09/ s3://smithlab-fiber/projects/embryo-timecourse/2026-09/ --profile lab-admin
```

For R2, B2, MinIO or an institutional store add `--endpoint-url`
(for example `https://<account-id>.r2.cloudflarestorage.com`,
`https://s3.us-west-004.backblazeb2.com`), or put `endpoint_url` in the
profile (step 6). `rclone` works too. Large files upload in parts
automatically.

## 4. Private or public?

- **Private** (the default everywhere): only people with a key can read.
  Use this for unpublished data.
- **Public**: anyone with the address can read and download. Fine for data
  that accompanies a paper. FiberBrowser reads public buckets with no
  credentials at all (it tries the configured key first, then anonymously).
  - AWS: turn off *Block Public Access* for that bucket and add a bucket
    policy allowing `s3:GetObject` on `arn:aws:s3:::<bucket>/public/*`.
  - R2: enable public access (an `r2.dev` address or your own domain); the
    `https://` addresses then work in FiberBrowser as they are.
  - B2: make the bucket *Public*.

A pre-signed link (`aws s3 presign s3://b/x.bam --expires-in 86400`) shares
one private file for a limited time. It covers one file only, so open it with
its index's own link: `<BAM link>##idx##<index link>`.

## 5. Read-only keys for lab members

Give people keys that can read the bucket and nothing else. One key per
person is easiest to revoke when someone leaves; one shared read-only key is
simpler. Either way, hand keys out through a password manager, never in a
catalog, a session file or a chat.

**AWS** (an IAM user or group with this policy):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {"Effect": "Allow", "Action": "s3:GetObject",
     "Resource": "arn:aws:s3:::smithlab-fiber/*"},
    {"Effect": "Allow", "Action": "s3:ListBucket",
     "Resource": "arn:aws:s3:::smithlab-fiber"}
  ]
}
```

`s3:ListBucket` lets people *browse* the bucket in FiberBrowser
(**Connect to cluster… → S3 bucket**). Without it they can still open a file
whose `s3://` path they know.

**Cloudflare R2**: *R2 → Manage API tokens → Create token*, permission
*Object Read only*, limited to the bucket. You get an access key ID, a
secret, and the endpoint `https://<account-id>.r2.cloudflarestorage.com`.

**Backblaze B2**: *Application Keys → Add a New Application Key*, access to
one bucket, *Read Only*. The key ID and application key are the access key
and secret; the endpoint is shown on the bucket page
(`https://s3.<region>.backblazeb2.com`).

**MinIO / institutional stores**: ask the administrator for a read-only key
(MinIO's `readonly` policy plus `s3:ListBucket` for browsing).

## 6. Set up FiberBrowser on each computer

FiberBrowser uses the standard AWS configuration files, in your home folder,
for every provider. Create (or add to) these two files:

```ini
# ~/.aws/credentials
[lab]
aws_access_key_id = <the read-only key ID>
aws_secret_access_key = <its secret>
```

```ini
# ~/.aws/config
[profile lab]
region = us-east-1
# Only for R2, B2, MinIO or an institutional store:
endpoint_url = https://<account-id>.r2.cloudflarestorage.com
```

(R2 accepts `region = auto`; B2 wants its own region, e.g. `us-west-004`.)
On a shared computer, `chmod 600 ~/.aws/credentials`.

**The Mac app** reads the same files. It does not see environment variables
from your shell profile (it starts from the Finder), so use the files rather
than `AWS_ACCESS_KEY_ID`.

**In the browser** (app or pip install): **Data & Sessions → Load Remote
URL → Load from URL…**, paste `s3://smithlab-fiber/projects/.../dl_2-4h.bam`,
type the profile (`lab`) and, if the profile doesn't set it, the endpoint,
then **Load**. The profile and endpoint stay in use for every `s3://` file
until you change them. To browse instead: **Connect to cluster… → S3 bucket**,
type `s3://smithlab-fiber/projects/`, the profile and the endpoint.

**From the command line** (pip install):

```bash
AWS_PROFILE=lab fiberbrowser -b s3://smithlab-fiber/projects/embryo-timecourse/2026-09/dl_2-4h.bam
```

**From Python / Jupyter** (`browser_client.py`):

```python
client.configure_s3(profile="lab", endpoint_url="https://<account-id>.r2.cloudflarestorage.com")
client.test_s3_access("s3://smithlab-fiber/projects/embryo-timecourse/2026-09/dl_2-4h.bam")
```

Nothing else needs installing: boto3 comes with FiberBrowser, and contact
maps no longer need `s3fs`.

## 7. A lab catalog

A catalog lists the lab's datasets so people tick them in **Data & Sessions**
instead of typing paths. Its `s3` block says where the bucket is; credentials
never go in it (each person's profile supplies them, and a public bucket needs
none):

```json
{
  "name": "Smith lab fiber-seq",
  "genome": "dm6",
  "s3": {"endpoint_url": "https://<account-id>.r2.cloudflarestorage.com", "profile": "lab"},
  "groups": [
    {
      "name": "Embryo time course, Sept 2026",
      "datasets": [
        {"url": "s3://smithlab-fiber/projects/embryo-timecourse/2026-09/dl_2-4h.bam", "label": "dl 2-4 h"},
        {"url": "s3://smithlab-fiber/projects/embryo-timecourse/2026-09/dl_4-6h.bam", "label": "dl 4-6 h"}
      ]
    }
  ],
  "tracks": [
    {"url": "s3://smithlab-fiber/annotations/enhancers.bb", "label": "Enhancers"}
  ]
}
```

Save it somewhere everyone can reach (a shared drive, the lab's repository)
and start FiberBrowser with it: `fiberbrowser --catalog smithlab.json`. Leave
out `"profile"` for a public bucket. The [Library](library.md) can write a
catalog for a group of datasets you already have open (**Export catalog**);
replace its local paths with the `s3://` addresses. A file that can't be
opened (missing, no index, no access) is named when its group is ticked; the
rest of the group still opens.

## Speed, cost and caching

Measured on a test setup (a 120 MB DAF-seq BAM in a local S3-compatible
server, with and without 50–150 ms of added network delay per response):

| Step | Local file | S3, no delay | S3, 100 ± 50 ms |
|------|-----------:|-------------:|----------------:|
| Open the dataset | 0.07 s | 0.5–2 s | 8–11 s |
| First reads, 50 kb with ~5,000 reads | 15–16 s | 15.5–16.5 s | 16.5–17 s |
| Pan by half a window | 0.12 s | 0.12 s | 0.13 s |
| Zoom out to 500 kb | 15–16 s | 15.5–17 s | 15.5–17 s |
| Zoom in to 10 kb | 0.08 s | 0.5 s | 0.5 s |
| Another chromosome, 50 kb | 10.5–11 s | 11–12 s | 11–11.5 s |
| Back to the first region | 0.13 s | 0.13 s | 0.13 s |

- The first view of a dense region is dominated by building the reads, not by
  the network; panning and returning to a region come from memory.
- Opening a dataset over a slow link takes several seconds: FiberBrowser
  samples a few dozen windows to find which layers the BAM has, and each is
  one round trip.
- Each BAM's index is downloaded **once** and kept in
  `~/.fiberhmm/remote_cache/index` (a new copy only when the BAM or index
  changes; folder from `FIBERBROWSER_REMOTE_CACHE`, at most
  `FIBERBROWSER_REMOTE_CACHE_MAX_MB` = 5 GB, entries unused for 30 days are
  removed). Nothing is written next to where FiberBrowser runs.
- Private objects are read through pre-signed links that FiberBrowser makes
  and renews itself (valid one hour, renewed five minutes before they expire);
  they never appear in logs, sessions or the browser.
- Footprint-class runs need the BAM on this computer. Download it, or just the
  region you need:

  ```bash
  aws s3 cp s3://smithlab-fiber/projects/.../dl_2-4h.bam . --profile lab      # whole file
  samtools view -b -X "$(aws s3 presign s3://smithlab-fiber/projects/.../dl_2-4h.bam --profile lab)" \
      "$(aws s3 presign s3://smithlab-fiber/projects/.../dl_2-4h.bam.bai --profile lab)" \
      chr2L:15400000-15600000 > region.bam && samtools index region.bam       # one region
  ```

## Troubleshooting

| Message | What to do |
|---------|------------|
| `Object not found: s3://… (on AWS S3)`, but the file is there | The bucket is on R2/B2/MinIO: set the endpoint (in the profile, the **Load Remote URL** form, or the catalog's `s3` block). |
| `… rejected profile 'lab' (SignatureDoesNotMatch)` or `(InvalidAccessKeyId)` | Wrong key or secret, or a key for another provider/endpoint. Re-copy both from the provider. |
| `Access denied: the bucket is not public and no credentials are configured` | Give a profile (form, catalog or `AWS_PROFILE`), or check that `~/.aws/credentials` has it. |
| `Access denied: … the configured credentials are not allowed this` | The key's policy doesn't cover this bucket or prefix; ask whoever made the key. |
| `Cannot list s3://…: Access denied … can still open a file` | The key may read but not list (`s3:ListBucket`). Type the file's path under **Load Remote URL**, or add the permission. |
| `No BAM index (.bai or .csi) found next to the BAM` | Upload `x.bam.bai` (or `.csi`) beside it, or name it: `s3://b/x.bam##idx##s3://b/other/x.bai`. With a pre-signed link, add the index's own link the same way. |
| `Cannot reach https://… (network down, or wrong endpoint URL?)` | Check the network/VPN and the endpoint's spelling (`https://`, no bucket name in it). |
| `The bucket is in another region …` | Set `region` in the profile to the bucket's region. |
| `Reading s3://… failed at chr…: the network or the server may be down` | The connection dropped while reading. When it is back, move or reload the region; FiberBrowser reconnects by itself. |
| A pre-signed `https://` link stops working | It expired; make a new one (FiberBrowser's own `s3://` links renew themselves). |
| The Mac app says no credentials, the terminal works | The app doesn't see shell variables: put the key in `~/.aws/credentials`. |

See also: [Data on a cluster](remote-cluster-data.md) (files on an SSH
cluster), [Open data from a link](open-from-links.md) (portals and pre-signed
links), and [A public server](../deployment/public-server.md) (publishing a
catalog on the web).
