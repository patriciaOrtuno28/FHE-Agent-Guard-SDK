FROM zamafhe/concrete-ml:latest

WORKDIR /app

# Copy only the compile script and requirements
COPY scripts/compile_random_forest.py ./scripts/
COPY requirements.txt .

# Install any extra deps on top of the base image
RUN pip install --no-cache-dir -r requirements.txt

# Output directory — mount a volume here to get the artefact on the host
RUN mkdir -p ./artifacts

# Default: full compilation. Pass --dry-run to just verify the environment.
ENTRYPOINT ["python", "scripts/compile_random_forest.py"]
CMD ["--output", "./artifacts"]