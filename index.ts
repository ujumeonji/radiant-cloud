import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";

const config = new pulumi.Config();
const environment = pulumi.getStack();

const ecrRepo = new aws.ecr.Repository("radiant-cloud-repo", {
  name: "radiant-cloud",
  imageScanningConfiguration: {
    scanOnPush: false,
  },
  forceDelete: true,
});

const lifecyclePolicy = new aws.ecr.LifecyclePolicy("radiant-cloud-lifecycle", {
  repository: ecrRepo.name,
  policy: JSON.stringify({
    rules: [
      {
        rulePriority: 1,
        description: "Keep last 3 untagged images",
        selection: {
          tagStatus: "untagged",
          countType: "imageCountMoreThan",
          countNumber: 3,
        },
        action: {
          type: "expire",
        },
      },
      {
        rulePriority: 2,
        description: "Keep last 5 tagged images",
        selection: {
          tagStatus: "tagged",
          tagPrefixList: ["any"],
          countType: "imageCountMoreThan",
          countNumber: 5,
        },
        action: {
          type: "expire",
        },
      },
      {
        rulePriority: 3,
        description: "Delete images older than 30 days",
        selection: {
          tagStatus: "any",
          countType: "sinceImagePushed",
          countNumber: 30,
          countUnit: "days",
        },
        action: {
          type: "expire",
        },
      },
    ],
  }),
});

const rdsInstance = new aws.rds.Instance("radiant-db", {
  identifier: "radiant-db",
  engine: "postgres",
  engineVersion: "15.12",
  instanceClass: "db.t3.micro",
  allocatedStorage: 20,
  dbName: "radiant",
  username: "radiantuser",
  manageMasterUserPassword: true,
  publiclyAccessible: true,
  skipFinalSnapshot: true,
  backupRetentionPeriod: 0,
  deleteAutomatedBackups: true,
  tags: {
    Environment: "production",
    Project: "radiant-cloud",
  },
});

const appRunnerInstanceRole = new aws.iam.Role("apprunner-instance-role", {
  assumeRolePolicy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Action: "sts:AssumeRole",
        Effect: "Allow",
        Principal: {
          Service: "tasks.apprunner.amazonaws.com",
        },
      },
    ],
  }),
});

const secretsManagerPolicy = new aws.iam.Policy("secrets-manager-policy", {
  policy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret",
        ],
        Resource: "*",
      },
    ],
  }),
});

new aws.iam.RolePolicyAttachment("apprunner-secrets-access", {
  role: appRunnerInstanceRole.name,
  policyArn: secretsManagerPolicy.arn,
});

const appRunnerAccessRole = new aws.iam.Role("apprunner-access-role", {
  assumeRolePolicy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Action: "sts:AssumeRole",
        Effect: "Allow",
        Principal: {
          Service: "build.apprunner.amazonaws.com",
        },
      },
    ],
  }),
});

new aws.iam.RolePolicyAttachment("apprunner-ecr-access", {
  role: appRunnerAccessRole.name,
  policyArn:
    "arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess",
});

const appRunnerService = new aws.apprunner.Service("radiant-api", {
  serviceName: "radiant-api",
  sourceConfiguration: {
    imageRepository: {
      imageIdentifier: pulumi.interpolate`${ecrRepo.repositoryUrl}:latest`,
      imageConfiguration: {
        port: "8080",
        runtimeEnvironmentVariables: {
          SPRING_PROFILES_ACTIVE: "prod",
          DB_HOST: rdsInstance.address,
          DB_PORT: "5432",
          DB_NAME: "radiant",
          DB_USERNAME: "radiantuser",
          DB_PASSWORD: "",
          S3_BUCKET_NAME: `radiant-media-${environment}`,
          CDN_DOMAIN: "https://cdn.radiant.ink",
          AWS_REGION: "ap-northeast-2",
          JWT_SECRET: "",
          OPENAI_API_KEY: "",
          OPENAI_BASE_URL: "https://openrouter.ai/api",
          OPENAI_MODEL: "gpt-4o-mini",
        },
      },
      imageRepositoryType: "ECR",
    },
    autoDeploymentsEnabled: true,
    authenticationConfiguration: {
      accessRoleArn: appRunnerAccessRole.arn,
    },
  },
  instanceConfiguration: {
    cpu: "0.25 vCPU",
    memory: "0.5 GB",
    instanceRoleArn: appRunnerInstanceRole.arn,
  },
  healthCheckConfiguration: {
    path: "/actuator/health",
    protocol: "HTTP",
    interval: 10,
    timeout: 5,
    healthyThreshold: 1,
    unhealthyThreshold: 5,
  },
  tags: {
    Environment: "production",
    Project: "radiant-cloud",
  },
});

const hostedZone = new aws.route53.Zone("radiant-ink-zone", {
  name: "radiant.ink",
  tags: {
    Environment: "production",
    Project: "radiant-cloud",
  },
});

const customDomain = new aws.apprunner.CustomDomainAssociation("api-domain", {
  serviceArn: appRunnerService.arn,
  domainName: "api.radiant.ink",
  enableWwwSubdomain: false,
});

const apiDnsRecord = new aws.route53.Record("api-radiant-dns", {
  zoneId: hostedZone.zoneId,
  name: "api.radiant.ink",
  type: "CNAME",
  ttl: 300,
  records: [customDomain.dnsTarget],
});

customDomain.certificateValidationRecords.apply((records) => {
  records.forEach((record, index) => {
    new aws.route53.Record(`api-cert-validation-${index}`, {
      name: record.name,
      records: [record.value],
      ttl: 60,
      type: record.type,
      zoneId: hostedZone.zoneId,
    });
  });
});

const mediaBucket = new aws.s3.Bucket("radiant-media-bucket", {
  bucket: `radiant-media-${environment}`,
  tags: {
    Environment: "production",
    Project: "radiant-cloud",
    Purpose: "media-storage",
  },
});

new aws.s3.BucketPublicAccessBlock("radiant-media-bucket-pab", {
  bucket: mediaBucket.id,
  blockPublicAcls: true,
  blockPublicPolicy: true,
  ignorePublicAcls: true,
  restrictPublicBuckets: true,
});

new aws.s3.BucketVersioning("radiant-media-bucket-versioning", {
  bucket: mediaBucket.id,
  versioningConfiguration: {
    status: "Enabled",
  },
});

new aws.s3.BucketServerSideEncryptionConfiguration(
  "radiant-media-bucket-encryption",
  {
    bucket: mediaBucket.id,
    rules: [
      {
        applyServerSideEncryptionByDefault: {
          sseAlgorithm: "AES256",
        },
      },
    ],
  },
);

new aws.s3.BucketLifecycleConfiguration("radiant-media-bucket-lifecycle", {
  bucket: mediaBucket.id,
  rules: [
    {
      id: "thumbnail-lifecycle",
      status: "Enabled",
      filter: {
        prefix: "thumbnails/",
      },
      transitions: [
        {
          days: 30,
          storageClass: "STANDARD_IA",
        },
        {
          days: 90,
          storageClass: "GLACIER",
        },
      ],
      expiration: {
        days: 365,
      },
    },
    {
      id: "temp-files-cleanup",
      status: "Enabled",
      filter: {
        prefix: "temp/",
      },
      expiration: {
        days: 7,
      },
    },
    {
      id: "original-media-lifecycle",
      status: "Enabled",
      filter: {
        prefix: "media/",
      },
      transitions: [
        {
          days: 60,
          storageClass: "STANDARD_IA",
        },
        {
          days: 180,
          storageClass: "GLACIER",
        },
      ],
    },
  ],
});

new aws.s3.BucketIntelligentTieringConfiguration(
  "radiant-media-bucket-intelligent-tiering",
  {
    bucket: mediaBucket.id,
    name: "EntireBucket",
    status: "Enabled",
    tierings: [
      {
        accessTier: "ARCHIVE_ACCESS",
        days: 90,
      },
      {
        accessTier: "DEEP_ARCHIVE_ACCESS",
        days: 180,
      },
    ],
  },
);

const originAccessIdentity = new aws.cloudfront.OriginAccessIdentity(
  "radiant-media-oai",
  {
    comment: "OAI for radiant media bucket",
  },
);

const bucketPolicy = new aws.s3.BucketPolicy("radiant-media-bucket-policy", {
  bucket: mediaBucket.id,
  policy: pulumi
    .all([mediaBucket.arn, originAccessIdentity.iamArn])
    .apply(([bucketArn, oaiArn]) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: {
              AWS: oaiArn,
            },
            Action: "s3:GetObject",
            Resource: `${bucketArn}/*`,
          },
        ],
      }),
    ),
});

const corsConfiguration = new aws.s3.BucketCorsConfiguration(
  "radiant-media-bucket-cors",
  {
    bucket: mediaBucket.id,
    corsRules: [
      {
        allowedHeaders: ["*"],
        allowedMethods: ["GET", "HEAD"],
        allowedOrigins: ["https://radiant.ink", "https://api.radiant.ink"],
        exposeHeaders: ["ETag"],
        maxAgeSeconds: 3000,
      },
    ],
  },
);

const cloudFrontDistribution = new aws.cloudfront.Distribution(
  "radiant-media-cdn",
  {
    origins: [
      {
        domainName: mediaBucket.bucketDomainName,
        originId: "S3-radiant-media",
        s3OriginConfig: {
          originAccessIdentity:
            originAccessIdentity.cloudfrontAccessIdentityPath,
        },
      },
    ],
    enabled: true,
    isIpv6Enabled: true,
    comment: "Radiant media CDN distribution",
    defaultRootObject: "index.html",
    defaultCacheBehavior: {
      allowedMethods: [
        "DELETE",
        "GET",
        "HEAD",
        "OPTIONS",
        "PATCH",
        "POST",
        "PUT",
      ],
      cachedMethods: ["GET", "HEAD"],
      targetOriginId: "S3-radiant-media",
      compress: true,
      viewerProtocolPolicy: "redirect-to-https",
      forwardedValues: {
        queryString: false,
        cookies: {
          forward: "none",
        },
      },
      minTtl: 0,
      defaultTtl: 86400,
      maxTtl: 31536000,
    },
    orderedCacheBehaviors: [
      {
        pathPattern: "thumbnails/*",
        allowedMethods: ["GET", "HEAD"],
        cachedMethods: ["GET", "HEAD"],
        targetOriginId: "S3-radiant-media",
        compress: true,
        viewerProtocolPolicy: "redirect-to-https",
        forwardedValues: {
          queryString: false,
          cookies: {
            forward: "none",
          },
        },
        minTtl: 0,
        defaultTtl: 604800,
        maxTtl: 31536000,
      },
      {
        pathPattern: "media/*",
        allowedMethods: ["GET", "HEAD"],
        cachedMethods: ["GET", "HEAD"],
        targetOriginId: "S3-radiant-media",
        compress: true,
        viewerProtocolPolicy: "redirect-to-https",
        forwardedValues: {
          queryString: false,
          cookies: {
            forward: "none",
          },
        },
        minTtl: 0,
        defaultTtl: 86400,
        maxTtl: 31536000,
      },
    ],
    restrictions: {
      geoRestriction: {
        restrictionType: "none",
      },
    },
    viewerCertificate: {
      cloudfrontDefaultCertificate: true,
    },
    tags: {
      Environment: "production",
      Project: "radiant-cloud",
    },
  },
);

const s3Policy = new aws.iam.Policy("s3-access-policy", {
  policy: mediaBucket.arn.apply((bucketArn) =>
    JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: [
            "s3:GetObject",
            "s3:PutObject",
            "s3:DeleteObject",
            "s3:ListBucket",
          ],
          Resource: [bucketArn, `${bucketArn}/*`],
        },
      ],
    }),
  ),
});

new aws.iam.RolePolicyAttachment("apprunner-s3-access", {
  role: appRunnerInstanceRole.name,
  policyArn: s3Policy.arn,
});

export const ecrRepositoryUrl = ecrRepo.repositoryUrl;
export const ecrRepositoryName = ecrRepo.name;
export const hostedZoneId = hostedZone.zoneId;
export const nameServers = hostedZone.nameServers;
export const appRunnerServiceUrl = appRunnerService.serviceUrl;
export const appRunnerServiceArn = appRunnerService.arn;
export const customDomainUrl = "https://api.radiant.ink";
export const databaseEndpoint = rdsInstance.endpoint;
export const databasePort = rdsInstance.port;
export const databaseName = rdsInstance.dbName;
export const databaseUsername = rdsInstance.username;
export const databaseSecretArn = rdsInstance.masterUserSecrets.apply(
  (secrets: any) => (secrets && secrets.length > 0 ? secrets[0].secretArn : ""),
);
export const s3BucketName = mediaBucket.id;
export const s3BucketArn = mediaBucket.arn;
export const cdnDomainName = cloudFrontDistribution.domainName;
export const cdnUrl = cloudFrontDistribution.domainName.apply(
  (domain) => `https://${domain}`,
);
