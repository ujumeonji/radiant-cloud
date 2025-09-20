import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";

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

export const ecrRepositoryUrl = ecrRepo.repositoryUrl;
export const ecrRepositoryName = ecrRepo.name;
export const hostedZoneId = hostedZone.zoneId;
export const nameServers = hostedZone.nameServers;
export const appRunnerServiceUrl = appRunnerService.serviceUrl;
export const appRunnerServiceArn = appRunnerService.arn;
export const customDomainUrl = "https://api.radiant.ink";
