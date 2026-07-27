# Opt-in cloud embedding tier (AWS)

A minimal, **stateless** embedding endpoint for the extension's optional cloud
tier. An API credential can't ship inside an inspectable extension bundle, so
this holds it server-side: API Gateway fronts a Lambda that invokes an Amazon
Bedrock embedding model and returns the vectors — persisting nothing.

```
POST /embed   { texts: string[] }  ->  { vectors: number[][], dims, model }
```

This is **opt-in**; the extension defaults to fully-local on-device embedding
(the project's whole thesis). The cloud tier just offers higher-quality
embeddings for users who choose it.

## Stack (commit 25)

- **API Gateway** (REST) — `POST /embed`. Usage plan / API key / throttling
  are added in commit 27.
- **Lambda** — the `/embed` handler (stub here; Bedrock wired in commit 26).
- **IAM role** — least privilege: `bedrock:InvokeModel` on exactly one model
  ARN, plus the default CloudWatch-logs permissions. Nothing else — no S3, no
  DynamoDB, no network egress config, because the handler stores nothing.

## Prerequisites

- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)
  and AWS credentials configured (`aws configure`).
- **Bedrock model access enabled** for `amazon.titan-embed-text-v2:0` in your
  target region (Bedrock console → *Model access* → enable Titan Text
  Embeddings V2). Without this, `InvokeModel` returns AccessDenied.

## Deploy

```bash
cd aws/src/embed && npm install && cd -   # esbuild, used by `sam build`
cd aws
sam build
sam deploy --guided                        # first time; writes samconfig.toml
```

`--guided` prompts for stack name, region, etc. Subsequent deploys are just
`sam build && sam deploy`. The stack outputs `EmbedEndpoint`.

## Verify

```bash
curl -sS -X POST "$EMBED_ENDPOINT" \
  -H 'content-type: application/json' \
  -d '{"texts":["hello world"]}'
```

At commit 25 the handler is a stub, so this returns `501 not implemented`
(proving the API → Lambda path is stood up). Commit 26 makes it return real
vectors.

## Least-privilege review (the commit-25 "done when")

The Lambda role grants only:
- `bedrock:InvokeModel` scoped to `arn:aws:bedrock:<region>::foundation-model/amazon.titan-embed-text-v2:0`
- CloudWatch Logs (via the managed `AWSLambdaBasicExecutionRole` SAM attaches)

No wildcards on Bedrock actions or resources, and no other services.
