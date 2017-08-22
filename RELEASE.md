# Package apollo-engine-js
1) Copy engine binaries into the `bin/` directory
2) Update version in `package.json`
3) Run `npm pack`
4) Publish the generated `.tgz` to s3 or gcp 
   For example:
   ```bash
   aws s3 cp apollo-engine-0.2.5.tgz s3://apollo-engine-deploy/apollo-engine-0.2.5.tgz --acl public-read
   ```
