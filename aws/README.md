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

- **API Gateway** (REST) — `POST /embed`, API key required. A usage plan
  throttles to 10 req/s (burst 20) with a 50k/day quota, plus stage-level
  throttling as a backstop. Keyless requests get 403 without reaching Lambda.
- **CloudWatch alarms** — 5XX errors (backend failures) and 4XX spikes
  (throttling/keyless abuse), both notifying an SNS topic; pass
  `AlarmEmail=<you>` as a parameter override to subscribe your inbox (the
  subscription must be confirmed via the email AWS sends).
- **Lambda** — the `/embed` handler: validates `{ texts: string[] }` (max 64
  texts, 8k chars each), invokes Titan V2 per text (1024 dims, normalized,
  concurrency-capped), returns `{ vectors, dims, model }`. Logs carry only
  counts, durations, and error class names — never request text.
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
# API key: aws apigateway get-api-keys --include-values (created by the stack)
curl -sS -X POST "$EMBED_ENDPOINT" \
  -H 'content-type: application/json' \
  -H "x-api-key: $EMBED_API_KEY" \
  -d '{"texts":["hello world"]}'
```

A newly deployed key can take a couple of minutes to propagate; brief 403s
right after `sam deploy` are expected.

Returns `{ vectors: [[...1024 floats]], dims: 1024, model: "amazon.titan-embed-text-v2:0" }`.
Vectors are unit-normalized (the index does dot-product cosine on unit
vectors). To confirm nothing is persisted and no request text is logged, send
a sentinel string and filter the function's CloudWatch log group for it — zero
hits; only `{"event":"embed_ok","texts":N,"ms":...}` lines appear.

## Least-privilege review (the commit-25 "done when")

The Lambda role grants only:
- `bedrock:InvokeModel` scoped to `arn:aws:bedrock:<region>::foundation-model/amazon.titan-embed-text-v2:0`
- CloudWatch Logs (via the managed `AWSLambdaBasicExecutionRole` SAM attaches)

No wildcards on Bedrock actions or resources, and no other services.
