# Webhooks Lambda
Lambda the sends a discord notification when the state of a pipeline changes

### Testing locally
1. Create a `venv` and install the dependencies
```bash
python3 -m venv .venv
source .venv/bin/activate
pip3 install -r requirements.txt
```

2. Run the function using `sam`
```bash
sam build
sam local invoke 
```