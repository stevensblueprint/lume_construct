import { 
  CfnOutput, 
  Duration, 
  RemovalPolicy, 
  SecretValue, 
  aws_route53_targets 
} from "aws-cdk-lib";
import {
  Distribution,
  OriginAccessIdentity,
  PriceClass,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { S3Origin } from "aws-cdk-lib/aws-cloudfront-origins";
import { BuildSpec, LinuxBuildImage, Project } from "aws-cdk-lib/aws-codebuild";
import { Artifact, Pipeline } from "aws-cdk-lib/aws-codepipeline";
import {
  CodeBuildAction,
  GitHubSourceAction,
  S3DeployAction,
} from "aws-cdk-lib/aws-codepipeline-actions";
import { CanonicalUserPrincipal, PolicyStatement } from "aws-cdk-lib/aws-iam";
import {
  BlockPublicAccess,
  Bucket,
  BucketAccessControl,
  BucketEncryption,
} from "aws-cdk-lib/aws-s3";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { 
  HostedZone, 
  ARecord, 
  RecordTarget 
} from "aws-cdk-lib/aws-route53";
import { Certificate } from "aws-cdk-lib/aws-certificatemanager";
import * as targets from "aws-cdk-lib/aws-events-targets"
import * as lambda from "aws-cdk-lib/aws-lambda"
import * as path from "path";
import * as utils from './utils';

interface LumeCdkTemplateStackProps extends cdk.StackProps {
  account: string;
  region: string;
  environmentType: string;
  branch: string;
  pipelineName: string;
  bucketName: string;
  publicAccess: boolean;
  indexFile: string;
  errorFile: string;
  githubRepoOwner: string;
  githubRepoName: string;
  githubAccessToken: string;
  domainName: string;
  subdomainName: string;
  certificateArn: string;
  discordWebhookURL: string;
}
export class LumeCdkTemplateStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: LumeCdkTemplateStackProps) {
    super(scope, id, props);
    /*------------------------lume deployment---------------------------*/
    const webBucket = this._createWebBucket(props);
    const distribution = this._createCloudFrontDistribution(webBucket, props);
    const aRecord = this._createARecord(props, distribution);

    /*------------------------codepipeline/cicd--------------------------*/
    const { sourceOutput, sourceAction } = this._createSourceAction(props);
    const { buildOutput, buildProject } = this._createBuildProject(
      distribution,
      props
    );
    const buildAction = this._createBuildAction(
      buildProject,
      sourceOutput,
      buildOutput
    );
    const deployAction = this._createDeployAction(buildOutput, webBucket);
    this._createPipeline(
      deployAction,
      sourceAction,
      buildAction,
      props,
      webBucket,
      distribution
    );
    this._outCloudfrontURL(distribution);
    this._outCustomDomainName(distribution);
    this._outS3BucketURL(webBucket);
  }

  private _createWebBucket(props: LumeCdkTemplateStackProps) {
    const { bucketName, indexFile, errorFile, publicAccess } = props;
    const webBucket = new Bucket(this, bucketName, {
      websiteIndexDocument: indexFile,
      websiteErrorDocument: errorFile,
      publicReadAccess: publicAccess,
      removalPolicy: RemovalPolicy.DESTROY,
      blockPublicAccess: BlockPublicAccess.BLOCK_ACLS,
      accessControl: BucketAccessControl.BUCKET_OWNER_FULL_CONTROL,
      encryption: BucketEncryption.S3_MANAGED,
    });

    return webBucket;
  }

  private _createCloudFrontDistribution(
    bucket: Bucket,
    props: LumeCdkTemplateStackProps
  ) {
    const oai = new OriginAccessIdentity(this, "OAI");
    bucket.addToResourcePolicy(
      new PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [bucket.arnForObjects("*")],
        principals: [
          new CanonicalUserPrincipal(
            oai.cloudFrontOriginAccessIdentityS3CanonicalUserId
          ),
        ],
      })
    );

    const s3Origin = new S3Origin(bucket, {
      originAccessIdentity: oai,
    });

    // This certificate must be created manually in AWS ACM
    // with corresponding domain name i.e "sitbluperint.com"
    const certificate = Certificate.fromCertificateArn(this, 'DomainCertificate', 
      props.certificateArn
    );

    const distribution = new Distribution(
      this,
      `${props.pipelineName}-deployment-distribution`,
      {
        defaultBehavior: {
          origin: s3Origin,
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
        defaultRootObject: "index.html",
        errorResponses: [
          {
            httpStatus: 404,
            responseHttpStatus: 404,
            responsePagePath: "/404.html",
            ttl: Duration.seconds(300),
          },
          {
            httpStatus: 403,
            responseHttpStatus: 500,
            responsePagePath: "/index.html",
            ttl: Duration.seconds(300),
          },
        ],
        priceClass: PriceClass.PRICE_CLASS_100,
        domainNames: [`${props.subdomainName}.${props.domainName}`],
        certificate: certificate
      }
    );

    return distribution;
  }

  private _createARecord(props: LumeCdkTemplateStackProps, distribution: Distribution) : ARecord {
    // This Hosted Zone must be created manually in AWS Route 53 
    // with corresponding domain name i.e "sitblueprint.com"
    const hostedZone = HostedZone.fromLookup(this, 'HostedZone', {
      domainName: props.domainName,
    });

    const domainARecord = new ARecord(this, 'AliasRecord', {
      zone: hostedZone,
      recordName: props.subdomainName,
      target: RecordTarget.fromAlias(
        new aws_route53_targets.CloudFrontTarget(distribution)
      ),
    });

    domainARecord.node.addDependency(distribution);

    return domainARecord;
  }

  /*--------------------------codepipeline/cicd---------------------------*/
  private _createSourceAction(props: LumeCdkTemplateStackProps) {
    const { githubRepoOwner, githubRepoName, githubAccessToken, branch } =
      props;
    const sourceOutput = new Artifact();
    const sourceAction = new GitHubSourceAction({
      actionName: "GitHub",
      owner: githubRepoOwner,
      repo: githubRepoName,
      branch: branch,
      oauthToken: cdk.SecretValue.secretsManager(props.githubAccessToken),
      output: sourceOutput,
    });

    return {
      sourceOutput,
      sourceAction,
    };
  }

  private _createBuildProject(
    distribution: Distribution,
    props: LumeCdkTemplateStackProps
  ) {
    const buildOutput = new Artifact();
    const buildProject = new Project(this, `${props.pipelineName}-build`, {
      buildSpec: BuildSpec.fromObject({
        version: "0.2",
        phases: {
          install: {
            commands: [
              'echo "Installing Deno"',
              "curl -fsSL https://deno.land/x/install/install.sh | sh",
              'export DENO_INSTALL="$HOME/.deno"',
              'export PATH="$DENO_INSTALL/bin:$PATH"',
              'echo "Deno installed successfully"',
              "deno --version",
            ],
          },
          build: {
            commands: [
              'echo "Building Lume site"',
              "deno task build",
              'echo "Build completed successfully"',
              'echo "Listing output directory contents:"',
              "ls -la",
            ],
          },
          post_build: {
            commands: [
              'echo "Creating CloudFront invalidation"',
              `aws cloudfront create-invalidation --distribution-id ${distribution.distributionId} --paths '/*'`,
            ],
          },
        },
        artifacts: {
          "base-directory": "output", // Changed from _site to output
          files: ["**/*"],
        },
      }),
      environment: {
        buildImage: LinuxBuildImage.AMAZON_LINUX_2_5,
      },
    });

    buildProject.addToRolePolicy(
      new PolicyStatement({
        actions: ["cloudfront:CreateInvalidation"],
        resources: [
          `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`,
        ],
      })
    );

    buildProject.addToRolePolicy(
      new PolicyStatement({
        actions: ["codebuild:StartBuild", "codebuild:BatchGetBuilds"],
        resources: [buildProject.projectArn],
      })
    );

    return {
      buildOutput,
      buildProject,
    };
  }

  private _createBuildAction(
    buildProject: Project,
    sourceOutput: Artifact,
    buildOutput: Artifact
  ) {
    const buildAction = new CodeBuildAction({
      actionName: "CodeBuild",
      project: buildProject,
      input: sourceOutput,
      outputs: [buildOutput],
    });

    return buildAction;
  }

  private _createDeployAction(buildOutput: Artifact, bucket: Bucket) {
    const deployAction = new S3DeployAction({
      actionName: "DeployToS3",
      input: buildOutput,
      bucket: bucket,
    });

    return deployAction;
  }

  private _createPipeline(
    deployAction: S3DeployAction,
    sourceAction: GitHubSourceAction,
    buildAction: CodeBuildAction,
    props: LumeCdkTemplateStackProps,
    bucket: Bucket,
    distribution: Distribution
  ) {
    const { pipelineName, discordWebhookURL } = props;

    const stages = [
      { stageName: "Source", actions: [sourceAction] },
      { stageName: "Build", actions: [buildAction] },
      { stageName: "Deploy", actions: [deployAction] },
    ];

    const codePipeline = new Pipeline(this, "codepipeline", {
      pipelineName: pipelineName,
      stages,
    });

    codePipeline.node.addDependency(bucket, distribution);
    if (!utils.isEmpty(discordWebhookURL)) {
      console.log('Creating webhook')
      this._addWebhook(codePipeline, props);
    }
  }

  private _addWebhook(pipeline: Pipeline, props: LumeCdkTemplateStackProps){
    const webhookLambda = new lambda.Function(this, "WebhookLambda", {
      runtime: lambda.Runtime.PYTHON_3_10,
      code: lambda.Code.fromAsset(path.join(__dirname, "../functions/pipeline-lambda")),
      handler: "src.handler",
      environment: {
        DISCORD_WEBHOOKS_URL: props.discordWebhookURL,
        PIPELINE_NAME: pipeline.pipelineName,
      }
    })
    
    pipeline.onStateChange(
      "WebhookEvent",
      {
        target: new targets.LambdaFunction(webhookLambda),
        description: "Lambda function to describe state changes",
      }
    )
  }

  private _outCloudfrontURL(distribution: Distribution) {
    new CfnOutput(this, "cloudfront-web-url", {
      value: distribution.distributionDomainName,
      description: "cloudfront website url",
    });
  }

  private _outS3BucketURL(bucket: Bucket) {
    new CfnOutput(this, "s3-bucket-web-url", {
      value: bucket.bucketWebsiteUrl,
      description: "s3 bucket website url",
    });
  }

  private _outCustomDomainName(distribution: Distribution) {
    new CfnOutput(this, "custom-domain-name", {
      value: distribution.domainName,
      description: "custom domain name"
    })
  }
}
