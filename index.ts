import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";

const ecrRepo = new aws.ecr.Repository("radiant-cloud-repo", {
  name: "radiant-cloud",
  imageScanningConfiguration: {
    scanOnPush: false,
  },
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

export const ecrRepositoryUrl = ecrRepo.repositoryUrl;
export const ecrRepositoryName = ecrRepo.name;
