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

const vpc = new awsx.ec2.Vpc("radiant-vpc", {
  numberOfAvailabilityZones: 2,
  enableDnsHostnames: true,
  enableDnsSupport: true,
  tags: {
    Environment: "production",
    Project: "radiant-cloud",
  },
});

const securityGroup = new aws.ec2.SecurityGroup("radiant-sg", {
  vpcId: vpc.vpcId,
  description: "Security group for Radiant Cloud ECS tasks",
  ingress: [
    {
      fromPort: 80,
      toPort: 80,
      protocol: "tcp",
      cidrBlocks: ["0.0.0.0/0"],
    },
    {
      fromPort: 443,
      toPort: 443,
      protocol: "tcp",
      cidrBlocks: ["0.0.0.0/0"],
    },
  ],
  egress: [
    {
      fromPort: 0,
      toPort: 0,
      protocol: "-1",
      cidrBlocks: ["0.0.0.0/0"],
    },
  ],
  tags: {
    Environment: "production",
    Project: "radiant-cloud",
  },
});

const instanceRole = new aws.iam.Role("ecs-instance-role", {
  assumeRolePolicy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Action: "sts:AssumeRole",
        Effect: "Allow",
        Principal: {
          Service: "ec2.amazonaws.com",
        },
      },
    ],
  }),
});

new aws.iam.RolePolicyAttachment("ecs-instance-role-policy", {
  role: instanceRole.name,
  policyArn:
    "arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role",
});

const instanceProfile = new aws.iam.InstanceProfile("ecs-instance-profile", {
  role: instanceRole.name,
});

const ecsRole = new aws.iam.Role("ecs-task-execution-role", {
  assumeRolePolicy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Action: "sts:AssumeRole",
        Effect: "Allow",
        Principal: {
          Service: "ecs-tasks.amazonaws.com",
        },
      },
    ],
  }),
});

new aws.iam.RolePolicyAttachment("ecs-task-execution-role-policy", {
  role: ecsRole.name,
  policyArn:
    "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
});

const cluster = new aws.ecs.Cluster("radiant-cluster", {
  tags: {
    Environment: "production",
    Project: "radiant-cloud",
  },
});

const launchTemplate = new aws.ec2.LaunchTemplate("radiant-launch-template", {
  imageId: "ami-0c02fb55956c7d316",
  instanceType: "t3.micro",
  iamInstanceProfile: {
    name: instanceProfile.name,
  },
  vpcSecurityGroupIds: [securityGroup.id],
  userData: pulumi.interpolate`#!/bin/bash
echo ECS_CLUSTER=${cluster.name} >> /etc/ecs/ecs.config`,
  tagSpecifications: [
    {
      resourceType: "instance",
      tags: {
        Environment: "production",
        Project: "radiant-cloud",
      },
    },
  ],
});

const autoScalingGroup = new aws.autoscaling.Group("radiant-asg", {
  mixedInstancesPolicy: {
    instancesDistribution: {
      onDemandBaseCapacity: 0,
      onDemandPercentageAboveBaseCapacity: 0,
      spotAllocationStrategy: "diversified",
    },
    launchTemplate: {
      launchTemplateSpecification: {
        launchTemplateId: launchTemplate.id,
        version: "$Latest",
      },
      overrides: [
        { instanceType: "t3.micro" },
        { instanceType: "t3.small" },
        { instanceType: "t2.micro" },
        { instanceType: "t2.small" },
      ],
    },
  },
  vpcZoneIdentifiers: vpc.privateSubnetIds,
  minSize: 1,
  maxSize: 5,
  desiredCapacity: 2,
  tags: [
    {
      key: "Environment",
      value: "production",
      propagateAtLaunch: true,
    },
    {
      key: "Project",
      value: "radiant-cloud",
      propagateAtLaunch: true,
    },
  ],
});

const capacityProvider = new aws.ecs.CapacityProvider("radiant-spot-capacity", {
  autoScalingGroupProvider: {
    autoScalingGroupArn: autoScalingGroup.arn,
    managedScaling: {
      status: "ENABLED",
      targetCapacity: 80,
      minimumScalingStepSize: 1,
      maximumScalingStepSize: 10,
    },
    managedTerminationProtection: "DISABLED",
  },
  tags: {
    Environment: "production",
    Project: "radiant-cloud",
  },
});

const clusterCapacityProviders = new aws.ecs.ClusterCapacityProviders(
  "radiant-cluster-capacity",
  {
    clusterName: cluster.name,
    capacityProviders: [capacityProvider.name],
    defaultCapacityProviderStrategies: [
      {
        capacityProvider: capacityProvider.name,
        weight: 1,
        base: 1,
      },
    ],
  },
);

const albSecurityGroup = new aws.ec2.SecurityGroup("radiant-alb-sg", {
  vpcId: vpc.vpcId,
  description: "Security group for Application Load Balancer",
  ingress: [
    {
      fromPort: 80,
      toPort: 80,
      protocol: "tcp",
      cidrBlocks: ["0.0.0.0/0"],
    },
    {
      fromPort: 443,
      toPort: 443,
      protocol: "tcp",
      cidrBlocks: ["0.0.0.0/0"],
    },
  ],
  egress: [
    {
      fromPort: 0,
      toPort: 0,
      protocol: "-1",
      cidrBlocks: ["0.0.0.0/0"],
    },
  ],
  tags: {
    Environment: "production",
    Project: "radiant-cloud",
  },
});

const targetGroup = new aws.lb.TargetGroup("radiant-tg", {
  port: 80,
  protocol: "HTTP",
  vpcId: vpc.vpcId,
  targetType: "ip",
  healthCheck: {
    enabled: true,
    healthyThreshold: 2,
    interval: 30,
    matcher: "200",
    path: "/",
    port: "traffic-port",
    protocol: "HTTP",
    timeout: 5,
    unhealthyThreshold: 2,
  },
  tags: {
    Environment: "production",
    Project: "radiant-cloud",
  },
});

const loadBalancer = new aws.lb.LoadBalancer("radiant-alb", {
  loadBalancerType: "application",
  subnets: vpc.publicSubnetIds,
  securityGroups: [albSecurityGroup.id],
  tags: {
    Environment: "production",
    Project: "radiant-cloud",
  },
});

const certificate = new aws.acm.Certificate(
  "radiant-cert",
  {
    domainName: "api.radiant.ink",
    validationMethod: "DNS",
    tags: {
      Environment: "production",
      Project: "radiant-cloud",
    },
  },
  {
    replaceOnChanges: ["domainName", "validationMethod"],
  },
);

const certificateValidation = new aws.acm.CertificateValidation(
  "radiant-cert-validation",
  {
    certificateArn: certificate.arn,
    validationRecordFqdns: certificate.domainValidationOptions.apply(
      (options) => options.map((option) => option.resourceRecordName),
    ),
  },
);

certificate.domainValidationOptions.apply((options) => {
  options.forEach((option, index) => {
    new aws.route53.Record(`radiant-cert-validation-${index}`, {
      name: option.resourceRecordName,
      records: [option.resourceRecordValue],
      ttl: 60,
      type: option.resourceRecordType,
      zoneId: hostedZone.zoneId,
    });
  });
});

const httpsListener = new aws.lb.Listener("radiant-https-listener", {
  loadBalancerArn: loadBalancer.arn,
  port: 443,
  protocol: "HTTPS",
  sslPolicy: "ELBSecurityPolicy-TLS-1-2-2017-01",
  certificateArn: certificateValidation.certificateArn,
  defaultActions: [
    {
      type: "forward",
      targetGroupArn: targetGroup.arn,
    },
  ],
});

const httpListener = new aws.lb.Listener("radiant-http-listener", {
  loadBalancerArn: loadBalancer.arn,
  port: 80,
  protocol: "HTTP",
  defaultActions: [
    {
      type: "redirect",
      redirect: {
        port: "443",
        protocol: "HTTPS",
        statusCode: "HTTP_301",
      },
    },
  ],
});

const taskDefinition = new aws.ecs.TaskDefinition("radiant-task", {
  family: "radiant-cloud",
  cpu: "256",
  memory: "512",
  networkMode: "awsvpc",
  requiresCompatibilities: ["EC2"],
  executionRoleArn: ecsRole.arn,
  containerDefinitions: JSON.stringify([
    {
      name: "radiant-container",
      image: pulumi.interpolate`${ecrRepo.repositoryUrl}:latest`,
      portMappings: [
        {
          containerPort: 80,
          protocol: "tcp",
        },
      ],
      essential: true,
      logConfiguration: {
        logDriver: "awslogs",
        options: {
          "awslogs-group": "/ecs/radiant-cloud",
          "awslogs-region": "us-east-1",
          "awslogs-stream-prefix": "ecs",
        },
      },
    },
  ]),
  tags: {
    Environment: "production",
    Project: "radiant-cloud",
  },
});

const logGroup = new aws.cloudwatch.LogGroup("radiant-logs", {
  name: "/ecs/radiant-cloud",
  retentionInDays: 7,
  tags: {
    Environment: "production",
    Project: "radiant-cloud",
  },
});

const service = new aws.ecs.Service("radiant-service", {
  cluster: cluster.id,
  taskDefinition: taskDefinition.arn,
  desiredCount: 2,
  launchType: "EC2",
  networkConfiguration: {
    subnets: vpc.privateSubnetIds,
    securityGroups: [securityGroup.id],
  },
  loadBalancers: [
    {
      targetGroupArn: targetGroup.arn,
      containerName: "radiant-container",
      containerPort: 80,
    },
  ],
  tags: {
    Environment: "production",
    Project: "radiant-cloud",
  },
});

const lambdaRole = new aws.iam.Role("lambda-deployment-role", {
  assumeRolePolicy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Action: "sts:AssumeRole",
        Effect: "Allow",
        Principal: {
          Service: "lambda.amazonaws.com",
        },
      },
    ],
  }),
});

const lambdaPolicy = new aws.iam.Policy("lambda-deployment-policy", {
  policy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
        Resource: "arn:aws:logs:*:*:*",
      },
      {
        Effect: "Allow",
        Action: ["ecs:UpdateService", "ecs:DescribeServices"],
        Resource: "*",
      },
    ],
  }),
});

new aws.iam.RolePolicyAttachment("lambda-deployment-policy-attachment", {
  role: lambdaRole.name,
  policyArn: lambdaPolicy.arn,
});

const deploymentLambda = new aws.lambda.Function("deployment-lambda", {
  runtime: "python3.9",
  role: lambdaRole.arn,
  handler: "index.handler",
  code: new pulumi.asset.AssetArchive({
    "index.py": new pulumi.asset.StringAsset(`
import json
import boto3

def handler(event, context):
    ecs = boto3.client('ecs')

    try:
        response = ecs.update_service(
            cluster='${cluster.name}',
            service='${service.name}',
            forceNewDeployment=True
        )

        return {
            'statusCode': 200,
            'body': json.dumps({
                'message': 'Deployment triggered successfully',
                'serviceArn': response['service']['serviceArn']
            })
        }
    except Exception as e:
        print(f"Error: {str(e)}")
        return {
            'statusCode': 500,
            'body': json.dumps({
                'message': 'Deployment failed',
                'error': str(e)
            })
        }
    `),
  }),
  tags: {
    Environment: "production",
    Project: "radiant-cloud",
  },
});

const eventRule = new aws.cloudwatch.EventRule("ecr-push-rule", {
  description: "Trigger on ECR image push",
  eventPattern: JSON.stringify({
    source: ["aws.ecr"],
    "detail-type": ["ECR Image Action"],
    detail: {
      "action-type": ["PUSH"],
      "repository-name": [ecrRepo.name],
    },
  }),
});

const lambdaPermission = new aws.lambda.Permission("allow-eventbridge", {
  statementId: "AllowExecutionFromEventBridge",
  action: "lambda:InvokeFunction",
  function: deploymentLambda.name,
  principal: "events.amazonaws.com",
  sourceArn: eventRule.arn,
});

const eventTarget = new aws.cloudwatch.EventTarget("lambda-target", {
  rule: eventRule.name,
  arn: deploymentLambda.arn,
});

const hostedZone = new aws.route53.Zone("radiant-ink-zone", {
  name: "radiant.ink",
  tags: {
    Environment: "production",
    Project: "radiant-cloud",
  },
});

const apiDnsRecord = new aws.route53.Record("api-radiant-dns", {
  zoneId: hostedZone.zoneId,
  name: "api.radiant.ink",
  type: "A",
  aliases: [
    {
      name: loadBalancer.dnsName,
      zoneId: loadBalancer.zoneId,
      evaluateTargetHealth: true,
    },
  ],
});

export const ecrRepositoryUrl = ecrRepo.repositoryUrl;
export const ecrRepositoryName = ecrRepo.name;
export const hostedZoneId = hostedZone.zoneId;
export const nameServers = hostedZone.nameServers;
export const loadBalancerDns = loadBalancer.dnsName;
export const clusterName = cluster.name;
export const serviceName = service.name;
export const certificateArn = certificate.arn;
